import { DEFAULT_CONFIG, mergeConfig, validateConfig, loadConfig } from './config.js';
import { createProviderRegistry } from './providers.js';
import { createToolRegistry } from './tools.js';
import { calculatorTool } from './builtin-tools.js';
import { loadPlugin, loadPluginsFromDirectory } from './plugins.js';
import { runAgent } from './orchestrator.js';
import { assembleContext } from './context.js';
import { Session } from './session.js';
import { KnowledgeBase } from './rag.js';
import { randomUUID } from 'node:crypto';

export class ThreadThink {
  constructor(options = {}) {
    this.config = validateConfig(mergeConfig(DEFAULT_CONFIG, options));
    this.providers = createProviderRegistry(options.providers || []);
    this.provider = this.providers.resolve(options.provider || this.config.provider, this.config.providerOptions);
    this.tools = createToolRegistry(this.config.toolLimits);
    this.plugins = [];
    this.hooks = [...(options.hooks || [])];
    this.session = new Session(options.session);
    this.rag = new KnowledgeBase(this.provider, this.config.rag);
    this._closed = false;
    this._active = null;
    this._pendingPlugins = new Set();
    this._disposePromise = null;
    try {
      if (this.config.builtinTools !== false && this.config.toolSettings?.calculator !== false) this.tools.registerTool(calculatorTool);
      for (var tool of options.tools || []) {
        var name = tool.name || tool.definition?.function?.name;
        if (this.config.toolSettings?.[name] !== false) this.tools.registerTool(tool);
      }
    } catch (error) {
      void this.tools.dispose();
      throw error;
    }
    this.ready = this._loadPlugins();
    // Keep construction failures observable through ready/chat without an unhandled rejection.
    this.ready.catch(() => {});
  }
  static async create(options = {}) {
    var config = await loadConfig(options);
    var app = new ThreadThink(config);
    try { await app.ready; return app; }
    catch (error) { await app.dispose(); throw error; }
  }
  async _loadPlugins() {
    try {
      var cwd = this.config.configDir || this.config.cwd || process.cwd();
      if (this.config.pluginDirectory) this.plugins.push(...await loadPluginsFromDirectory(this.config.pluginDirectory, this.tools, { cwd }));
      for (var spec of this.config.plugins) this.plugins.push(await loadPlugin(spec, this.tools, { cwd }));
      for (var [name, enabled] of Object.entries(this.config.toolSettings || {})) if (enabled === false) await this.tools.unregisterTool(name);
    } catch (error) {
      await Promise.allSettled(this.plugins.map(plugin => plugin.dispose()));
      await this.tools.dispose();
      throw error;
    }
  }
  registerTool(tool) {
    if (this._closed) throw new Error('ThreadThink 已释放');
    return this.tools.registerTool(tool);
  }
  async loadPlugin(spec) {
    await this.ready;
    if (this._closed) throw new Error('ThreadThink 已释放');
    var loading = loadPlugin(spec, this.tools, { cwd: this.config.configDir || this.config.cwd });
    this._pendingPlugins.add(loading);
    try {
      var plugin = await loading;
      this.plugins.push(plugin);
      return plugin;
    } finally { this._pendingPlugins.delete(loading); }
  }
  addPreStepHook(hook) {
    if (typeof hook !== 'function') throw new TypeError('Hook 必须是函数');
    this.hooks.push(hook);
    return () => { var index = this.hooks.indexOf(hook); if (index !== -1) this.hooks.splice(index, 1); };
  }
  async addDocument(text, metadata) { await this.ready; if (this._closed) throw new Error('ThreadThink 已释放'); return this.rag.add(text, metadata); }
  async chat(message, options = {}) {
    await this.ready;
    if (this._closed) throw new Error('ThreadThink 已释放');
    if (this._active) throw new Error('同一实例已有运行中的对话；并发任务请使用独立实例');
    if (typeof message !== 'string' || !message.trim()) throw new TypeError('message 不能为空');
    var controller = new AbortController();
    var signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    var release;
    var completed = new Promise(resolve => { release = resolve; });
    this._active = { controller, completed };
    var traceId = randomUUID();
    var kind = options.kind || 'chat';
    try {
      signal.throwIfAborted();
      var history = this.session.messages({ upTo: options.upTo });
      var rag = await this.rag.search(message, { signal });
      var context = typeof options.context === 'string' ? { source: options.context } : options.context || {};
      var assembled = options.contextMessages
        ? { messages: options.contextMessages, sections: [] }
        : await assembleContext({ persona: this.config.persona, history, rag, ...context }, { sections: options.sections, budgets: this.config.contextBudgets });
      var messages = [...assembled.messages, { role: 'user', content: message }];
      this.session.append('user_message', { id: randomUUID(), role: 'user', content: message, kind, annotationId: options.annotationId }, traceId);
      this.session.append('context_sections', { sections: assembled.sections }, traceId);
      var result = await runAgent({
        messages, provider: this.provider, tools: this.tools, hooks: this.hooks, signal, traceId,
        maxToolRounds: this.config.maxToolRounds, maxConsecutiveFailures: this.config.maxConsecutiveFailures,
        context: { ...options.toolContext, kind, annotationId: options.annotationId, sessionId: this.session.id },
        onToken: options.onToken, onToolStart: options.onToolStart, onToolEnd: options.onToolEnd,
        onEvent: async event => { this.session.append(event.type, event.payload, event.traceId); await options.onEvent?.(event); },
      });
      if (!['aborted', 'blocked'].includes(result.termination.reason)) this.session.append('ai_message', { id: randomUUID(), role: 'assistant', content: result.content, kind, annotationId: options.annotationId }, traceId);
      return result;
    } finally { this._active = null; release(); }
  }
  async annotate({ selectedText, question, source, thread = [], annotationId = randomUUID(), ...options }) {
    if (!selectedText || !question) throw new TypeError('批注需要 selectedText 与 question');
    return this.chat(question, { ...options, kind: 'annotation', annotationId, context: { source, selectedText, thread } });
  }
  async dispose() {
    if (this._disposePromise) return this._disposePromise;
    this._closed = true;
    this._disposePromise = (async () => {
      this._active?.controller.abort(new Error('ThreadThink 已释放'));
      await this._active?.completed;
      try { await this.ready; } catch { /* loading already rolled back */ }
      await Promise.allSettled(this._pendingPlugins);
      var errors = [];
      for (var plugin of [...this.plugins].reverse()) try { await plugin.dispose(); } catch (error) { errors.push(error); }
      try { await this.tools.dispose(); } catch (error) { errors.push(error); }
      try { await this.provider.dispose?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'ThreadThink 释放失败');
    })();
    return this._disposePromise;
  }
}

export { runAgent } from './orchestrator.js';
export { createToolRegistry } from './tools.js';
export { calculatorTool } from './builtin-tools.js';
export { createProviderRegistry, createMockProvider, createOpenAICompatibleProvider, createAnthropicProvider } from './providers.js';
export { loadConfig, mergeConfig, DEFAULT_CONFIG } from './config.js';
export { loadPlugin, loadPluginsFromDirectory } from './plugins.js';
export { assembleContext, createContextSections, estimateTokens } from './context.js';
export { Session } from './session.js';
