/* Provider transports extracted from ai.service.js. No tool loop or host state here. */

export function isAnthropicApi(apiBase) {
  try { return new URL(apiBase).hostname === 'api.anthropic.com'; } catch { return false; }
}

export function normalizeResponse(response, anthropic = false) {
  if (!response || typeof response !== 'object') throw new Error('AI API 返回了无效响应');
  if (!anthropic) {
    var choice = response.choices?.[0];
    if (!choice?.message || !choice.finish_reason) throw new Error('AI API 返回了无效响应');
    var calls = choice.message.tool_calls ?? [];
    if (!Array.isArray(calls)) throw new Error('AI API 返回了无效工具调用');
    return { content: choice.message.content || '', toolCalls: calls, finishReason: choice.finish_reason, usage: response.usage || {} };
  }
  if (!Array.isArray(response.content) || !response.content.length || !response.stop_reason) throw new Error('AI API 返回了无效响应');
  var calls = response.content.filter(block => block?.type === 'tool_use').map(block => {
    if (!block.id || !block.name) throw new Error('AI API 返回了无效工具调用');
    return { id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } };
  });
  return {
    content: response.content.filter(block => block?.type === 'text').map(block => block.text || '').join(''),
    toolCalls: calls,
    finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : response.stop_reason,
    usage: response.usage || {},
    providerContent: response.content,
  };
}

export function convertForAnthropic(messages) {
  var result = [];
  for (var message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      var last = result.at(-1);
      var block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content };
      if (message.is_error) block.is_error = true;
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(item => item.type === 'tool_result')) last.content.push(block);
      else result.push({ role: 'user', content: [block] });
    } else if (message.providerContent) {
      result.push({ role: 'assistant', content: message.providerContent });
    } else if (message.tool_calls) {
      var blocks = message.content ? [{ type: 'text', text: message.content }] : [];
      for (var call of message.tool_calls) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
      result.push({ role: 'assistant', content: blocks });
    } else result.push({ role: message.role, content: message.content });
  }
  return result;
}

/** Strict SSE reader: UTF-8/CRLF/multiline data and terminal-event validation. */
export async function* readProviderStream(response, anthropic = false) {
  if (!response.body?.getReader) throw new Error('AI API 返回了无效流');
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var eventData = [];
  var terminal = false;
  function event() {
    if (!eventData.length) return [];
    var data = eventData.join('\n');
    eventData = [];
    if (data === '[DONE]') { terminal = true; return []; }
    var json;
    try { json = JSON.parse(data); } catch { throw new Error('AI 流返回了无效事件'); }
    if (json.error || json.type === 'error') throw new Error('AI API 流错误: ' + (json.error?.message || json.error?.type || json.message || 'provider error'));
    if (anthropic && json.type === 'message_stop') { terminal = true; return []; }
    var choice = json.choices?.[0];
    if (choice?.finish_reason === 'error') throw new Error('AI API 流错误');
    var text = anthropic ? (json.type === 'content_block_delta' ? json.delta?.text : '') : choice?.delta?.content;
    var events = typeof text === 'string' && text ? [{ type: 'text', text }] : [];
    if (json.usage) events.push({ type: 'usage', usage: json.usage });
    if (json.message?.usage) events.push({ type: 'usage', usage: json.message.usage });
    if (json.delta?.stop_reason) events.push({ type: 'stop', finishReason: json.delta.stop_reason });
    if (choice?.finish_reason) events.push({ type: 'stop', finishReason: choice.finish_reason });
    return events;
  }
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) return event();
    if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
    return [];
  }
  try {
    while (true) {
      var next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        if (buffer) yield* line(buffer);
        yield* event();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop();
      for (var value of lines) yield* line(value);
    }
    if (!terminal) throw new Error('AI 流在终止事件前中断');
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

function httpProvider(kind, config = {}) {
  var anthropic = kind === 'anthropic';
  var base = config.apiBase || config.baseURL || (anthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.deepseek.com/v1/chat/completions');
  // Accept either a full endpoint (legacy settings) or an API base URL.
  if (!anthropic && !/\/chat\/completions\/?$/.test(base)) base = base.replace(/\/$/, '') + '/chat/completions';
  if (anthropic && !/\/messages\/?$/.test(base)) base = base.replace(/\/$/, '') + '/messages';
  var model = config.model || (anthropic ? 'claude-opus-5-5' : 'deepseek-chat');
  async function request(messages, options, stream) {
    var apiKey = config.apiKey || process.env[config.apiKeyEnv || (anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')];
    if (!apiKey) throw new Error('请先配置 provider API Key（或使用 mock）');
    var body = { model, max_tokens: config.maxTokens || 4096, stream };
    if (anthropic) {
      body.system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
      body.messages = convertForAnthropic(messages);
      if (options.tools?.length) body.tools = options.tools.map(item => ({ name: item.function.name, description: item.function.description, input_schema: item.function.parameters }));
    } else {
      body.messages = messages.map(({ providerContent, ...message }) => message);
      if (options.tools?.length) { body.tools = options.tools; body.tool_choice = 'auto'; }
    }
    var headers = { 'Content-Type': 'application/json' };
    if (anthropic) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else headers.Authorization = 'Bearer ' + apiKey;
    var timeout = AbortSignal.timeout(config.timeoutMs || 120000);
    var signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    var response = await (config.fetch || globalThis.fetch)(base, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error('AI API ' + response.status + ': ' + (await response.text()).slice(0, 300));
    return response;
  }
  return {
    name: kind,
    supports: provider => provider === kind,
    async complete(messages, options = {}) { return normalizeResponse(await (await request(messages, options, false)).json(), anthropic); },
    async *chat(messages, options = {}) { yield* readProviderStream(await request(messages, { ...options, tools: [] }, true), anthropic); },
    ...(anthropic ? {} : {
      async embed(texts, options = {}) {
        var apiKey = config.apiKey || process.env[config.apiKeyEnv || 'OPENAI_API_KEY'];
        if (!apiKey) throw new Error('请先配置 provider API Key（或使用 mock）');
        var response = await (config.fetch || globalThis.fetch)(config.embeddingBase || base.replace(/\/chat\/completions\/?$/, '/embeddings'), {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ model: config.embeddingModel || 'text-embedding-3-small', input: texts }), signal: options.signal,
        });
        if (!response.ok) throw new Error('Embedding API ' + response.status);
        var body = await response.json();
        if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('Embedding API 返回了无效响应');
        return body.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
      },
    }),
  };
}

export function createOpenAICompatibleProvider(config = {}) { return httpProvider('openai-compatible', config); }
export function createAnthropicProvider(config = {}) { return httpProvider('anthropic', config); }

/** Deterministic provider; scripts contain normalized responses, strings, or functions. */
export function createMockProvider(options = {}) {
  if (options.chunkSize !== undefined && (!Number.isInteger(options.chunkSize) || options.chunkSize < 1)) throw new TypeError('Mock chunkSize 必须是正整数');
  var script = [...(options.responses || [])];
  var requests = [];
  var position = 0;
  var disposed = false;
  return {
    name: 'mock', requests,
    supports: provider => provider === 'mock',
    async complete(messages, context = {}) {
      if (disposed) throw new Error('Provider 已释放');
      context.signal?.throwIfAborted();
      requests.push({ messages: structuredClone(messages), tools: structuredClone(context.tools || []) });
      var value = position < script.length ? script[position++] : options.reply;
      if (typeof value === 'function') value = await value(messages, context);
      if (value instanceof Error) throw value;
      if (value === undefined) value = 'Mock: ' + (messages.findLast(item => item.role === 'user')?.content || '');
      if (typeof value === 'string') return { content: value, toolCalls: [], finishReason: 'stop', usage: {} };
      if (value?.choices) return normalizeResponse(value);
      return { content: '', toolCalls: [], finishReason: value?.toolCalls?.length ? 'tool_calls' : 'stop', ...value };
    },
    async *chat(messages, context = {}) {
      var response = context.response || await this.complete(messages, context);
      var size = options.chunkSize || 16;
      for (var i = 0; i < response.content.length; i += size) {
        context.signal?.throwIfAborted();
        yield { type: 'text', text: response.content.slice(i, i + size) };
      }
      for (var call of response.toolCalls || []) yield { type: 'tool_call', call };
      yield { type: 'done', finishReason: response.finishReason, usage: response.usage };
    },
    async embed(texts) {
      return texts.map(text => {
        var vector = Array(32).fill(0);
        for (var char of text.toLowerCase()) vector[char.codePointAt(0) % vector.length]++;
        var norm = Math.hypot(...vector) || 1;
        return vector.map(value => value / norm);
      });
    },
    dispose() { disposed = true; },
  };
}

export function createProviderRegistry(adapters = []) {
  var providers = [...adapters];
  return {
    register(adapter) {
      if (!adapter || typeof adapter.supports !== 'function' || typeof adapter.chat !== 'function') throw new TypeError('Provider 需要 supports 与 chat 方法');
      providers.push(adapter);
      return () => { var index = providers.indexOf(adapter); if (index !== -1) providers.splice(index, 1); };
    },
    resolve(provider = 'mock', config = {}) {
      if (typeof provider === 'object' && provider !== null) {
        if (typeof provider.chat !== 'function') throw new TypeError('Provider 需要 chat 方法');
        return provider;
      }
      var custom = providers.findLast(adapter => adapter.supports(provider));
      if (custom) return custom;
      if (provider === 'mock') return createMockProvider(config);
      if (provider === 'openai-compatible') return createOpenAICompatibleProvider(config);
      if (provider === 'anthropic') return createAnthropicProvider(config);
      throw new Error('未知 provider: ' + provider);
    },
  };
}
