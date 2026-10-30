import Ajv from 'ajv';
import { createDeadline, abortable, boundedTimeout } from './tool-runtime.js';

var DEFAULTS = { timeoutMs: 10000, maxInputBytes: 65536, maxOutputBytes: 262144, maxConcurrent: 8 };

function failure(code, message) { return { error: message, code: code }; }

// Reject non-JSON values before stringify (which silently loses NaN/undefined),
// and bound depth/node/string size before schema validation or materialization.
function jsonSnapshot(value, maxBytes) {
  var seen = new Set();
  var nodes = 0;
  var estimatedBytes = 0;
  function visit(item, depth) {
    if (++nodes > 20000 || depth > 48) throw new Error('JSON 结构过于复杂');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') {
      estimatedBytes += Buffer.byteLength(item);
      if (estimatedBytes > maxBytes) throw new Error('JSON 大小超过限制');
      return;
    }
    if (typeof item !== 'object' || seen.has(item)) throw new Error('返回值或参数必须是有限的 JSON 数据');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error('只支持普通 JSON 对象');
    }
    if (Array.isArray(item)) {
      if (item.length > 20000 || Object.keys(item).length !== item.length) throw new Error('JSON 数组过长或包含空位');
      for (var index = 0; index < item.length; index++) if (!Object.hasOwn(item, index)) throw new Error('JSON 数组不能包含空位');
    }
    seen.add(item);
    for (var key of Object.keys(item)) {
      estimatedBytes += Buffer.byteLength(key);
      if (estimatedBytes > maxBytes) throw new Error('JSON 大小超过限制');
      visit(item[key], depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  var text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new Error('JSON 大小超过限制');
  return JSON.parse(text);
}

function schemaFor(parameters) {
  if (!parameters) return { type: 'object', properties: {}, additionalProperties: false };
  // Support design.md's shorthand {query:{type:'string'}} as well as JSON Schema.
  if (!parameters.type && !parameters.properties && !parameters.$ref && !parameters.anyOf && !parameters.allOf && !parameters.oneOf) {
    return { type: 'object', properties: parameters, required: Object.keys(parameters), additionalProperties: false };
  }
  return parameters;
}

export function createToolRegistry(options) {
  var opts = options || {};
  var limits = {};
  for (var key of Object.keys(DEFAULTS)) {
    var value = opts[key] === undefined ? DEFAULTS[key] : opts[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('无效的工具资源限制: ' + key);
    limits[key] = value;
  }
  var tools = new Map();
  var ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, addUsedSchema: false });
  var active = 0;
  var disposed = false;

  function registerTool(nameOrTool, definition, execute) {
    if (disposed) throw new Error('工具注册表已卸载');
    var plugin = typeof nameOrTool === 'string' ? { name: nameOrTool, definition: definition, execute: execute } : nameOrTool;
    if (!plugin || typeof plugin.execute !== 'function') throw new TypeError('工具必须提供 execute');
    var def = plugin.definition || plugin;
    var body = def.function || def;
    var name = plugin.name || body.name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new TypeError('无效的工具名称');
    if (body.name && body.name !== name) throw new TypeError('工具名称与定义不一致');
    if (tools.has(name)) throw new Error('工具已注册: ' + name);
    var output = plugin.output || def.output || body.output || {};
    var inputSchema = jsonSnapshot(schemaFor(body.parameters || body.inputSchema || body.input_schema), limits.maxInputBytes);
    if (inputSchema.type !== 'object') throw new TypeError('工具参数 schema 必须为 object');
    var outputSchema = output.schema || body.outputSchema;
    if (outputSchema) outputSchema = jsonSnapshot(outputSchema, limits.maxInputBytes);
    if (outputSchema && outputSchema.type !== 'object') throw new TypeError('工具输出 schema 必须为 object（MCP structuredContent）');
    var entry = {
      name: name, description: String(body.description || ''), inputSchema: inputSchema, outputSchema: outputSchema,
      validateInput: ajv.compile(inputSchema), validateOutput: outputSchema ? ajv.compile(outputSchema) : null,
      execute: plugin.execute.bind(plugin), dispose: typeof plugin.dispose === 'function' ? plugin.dispose.bind(plugin) : null,
      render: output.render, presentationMeta: output.presentationMeta,
      timeoutMs: boundedTimeout(plugin.timeoutMs, limits.timeoutMs), running: new Set(),
    };
    tools.set(name, entry);
    return async function () { return unregisterEntry(name, entry); };
  }

  async function unregisterEntry(name, expected) {
    var entry = tools.get(name);
    if (!entry || (expected && entry !== expected)) return false;
    tools.delete(name);
    for (var deadline of entry.running) deadline.abort(new Error('工具已卸载'));
    if (entry.dispose) {
      var cleanup = createDeadline(null, limits.timeoutMs);
      try { await abortable(Promise.resolve().then(entry.dispose), cleanup.signal); }
      finally { cleanup.dispose(); }
    }
    return true;
  }

  function getToolDefinitions() {
    return Array.from(tools.values(), function (entry) {
      return { type: 'function', function: { name: entry.name, description: entry.description, parameters: jsonSnapshot(entry.inputSchema, limits.maxInputBytes) } };
    });
  }

  function getMcpToolDefinitions() {
    return Array.from(tools.values(), function (entry) {
      var def = { name: entry.name, description: entry.description, inputSchema: jsonSnapshot(entry.inputSchema, limits.maxInputBytes) };
      if (entry.outputSchema) def.outputSchema = jsonSnapshot(entry.outputSchema, limits.maxInputBytes);
      return def;
    });
  }

  async function executeTool(name, args, context) {
    var entry = tools.get(name);
    if (!entry) return failure('UNKNOWN_TOOL', '未知工具: ' + name);
    var input;
    try {
      input = jsonSnapshot(args === undefined ? {} : args, limits.maxInputBytes);
      if (!entry.validateInput(input)) return failure('INVALID_INPUT', '工具参数校验失败: ' + ajv.errorsText(entry.validateInput.errors));
    } catch (error) { return failure('INVALID_INPUT', '工具参数校验失败: ' + error.message); }
    var ctx = context || {};
    if (ctx.signal && ctx.signal.aborted) return failure('TOOL_CANCELLED', '工具调用已取消');
    if (active >= limits.maxConcurrent) return failure('TOOL_BUSY', '工具并发已达上限');
    var deadline = createDeadline(ctx.signal, boundedTimeout(ctx.timeoutMs, entry.timeoutMs));
    entry.running.add(deadline);
    active++;
    var task = Promise.resolve().then(function () {
      deadline.signal.throwIfAborted();
      return entry.execute(input, { ...ctx, signal: deadline.signal, timeoutMs: boundedTimeout(ctx.timeoutMs, entry.timeoutMs) });
    });
    // Retain capacity for non-cooperative asynchronous plugins until they settle.
    // Trusted in-process plugins are not a VM/OS sandbox for arbitrary JS.
    task.then(release, release);
    function release() { active--; entry.running.delete(deadline); }
    try {
      var result = await abortable(task, deadline.signal);
      try {
        result = jsonSnapshot(result, limits.maxOutputBytes);
        var isError = result && typeof result.error === 'string';
        if (!isError && entry.validateOutput && !entry.validateOutput(result)) {
          return failure('INVALID_OUTPUT', '工具输出校验失败: ' + ajv.errorsText(entry.validateOutput.errors));
        }
        return result;
      } catch (error) { return failure('INVALID_OUTPUT', '工具输出校验失败: ' + error.message); }
    } catch (error) {
      if (deadline.signal.aborted) {
        return failure(deadline.signal.reason && deadline.signal.reason.code === 'TOOL_TIMEOUT' ? 'TOOL_TIMEOUT' : 'TOOL_CANCELLED', '工具调用超时或已取消');
      }
      return failure('TOOL_ERROR', '工具执行异常: ' + error.message);
    } finally { deadline.dispose(); }
  }

  function renderToolResult(name, args, value) {
    var entry = tools.get(name);
    var safeValue = jsonSnapshot(value, limits.maxOutputBytes);
    // A renderer for a success schema must never consume an error-shaped value.
    var rendered = entry && typeof entry.render === 'function' && !(safeValue && typeof safeValue.error === 'string') ?
      entry.render(args, safeValue) : JSON.stringify(safeValue);
    if (typeof rendered !== 'string' || Buffer.byteLength(rendered) > limits.maxOutputBytes) throw new Error('工具渲染输出无效或超过限制');
    return rendered;
  }

  function getToolPresentationMeta(name, args, value) {
    var entry = tools.get(name);
    if (!entry || typeof entry.presentationMeta !== 'function' || (value && typeof value.error === 'string')) return null;
    return jsonSnapshot(entry.presentationMeta(args, jsonSnapshot(value, limits.maxOutputBytes)), limits.maxOutputBytes);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    var results = await Promise.allSettled(Array.from(tools.keys(), function (name) { return unregisterEntry(name); }));
    var errors = results.filter(function (result) { return result.status === 'rejected'; });
    if (errors.length) throw new AggregateError(errors.map(function (result) { return result.reason; }), '工具卸载失败');
  }

  for (var tool of opts.tools || []) registerTool(tool);
  return {
    registerTool: registerTool, unregisterTool: unregisterEntry, dispose: dispose,
    getToolDefinitions: getToolDefinitions, getMcpToolDefinitions: getMcpToolDefinitions,
    executeTool: executeTool, renderToolResult: renderToolResult,
    getToolPresentationMeta: getToolPresentationMeta, presentationMeta: getToolPresentationMeta,
    hasTool: function (name) { return tools.has(name); },
  };
}
