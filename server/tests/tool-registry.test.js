import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/services/tools/registry.js';

function example(overrides) {
  return { name: 'example', description: 'Example tool',
    parameters: { type: 'object', required: ['count'], additionalProperties: false,
      properties: { count: { type: 'integer', minimum: 1, maximum: 5 }, nested: { type: 'array', maxItems: 2, items: { type: 'string' } } } },
    output: { schema: { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'number' } } },
      render: function (args, value) { return 'Value: ' + value.value; },
      presentationMeta: function (args, value) { return { label: String(value.value) }; } },
    execute: async function (args) { return { value: args.count * 2 }; }, ...overrides };
}

test('registry isolates instances, supports shorthand and legacy definitions, exports wire-safe schemas', async function () {
  var a = createToolRegistry({ tools: [example()] });
  var b = createToolRegistry();
  assert.equal(b.hasTool('example'), false);
  assert.equal((await b.executeTool('example', {})).code, 'UNKNOWN_TOOL');
  assert.equal((await b.executeTool('__proto__', {})).code, 'UNKNOWN_TOOL');
  var defs = a.getToolDefinitions();
  assert.equal(defs[0].function.output, undefined);
  defs[0].function.parameters.properties.count.type = 'string';
  assert.deepEqual(await a.executeTool('example', { count: 2 }), { value: 4 });
  assert.equal(a.getMcpToolDefinitions()[0].outputSchema.properties.value.type, 'number');
  b.registerTool('legacy', { type: 'function', function: { name: 'legacy', parameters: { type: 'object', properties: {} } } }, async function () { return {}; });
  b.registerTool({ name: 'short', parameters: { query: { type: 'string' } }, execute: async function (args) { return args; } });
  assert.equal((await b.executeTool('short', {})).code, 'INVALID_INPUT');
  assert.deepEqual(await b.executeTool('short', { query: 'hello' }), { query: 'hello' });
  assert.throws(function () { a.registerTool(example()); }, /已注册/);
  assert.throws(function () { b.registerTool('mismatch', { name: 'other' }, function () {}); }, /不一致/);
  assert.throws(function () { b.registerTool({ name: 'bad', parameters: { type: 'nonsense' }, execute: function () {} }); });
  await a.dispose(); await b.dispose();
});

test('schema rejects malformed arguments without running tools or coercing input', async function () {
  var calls = 0;
  var registry = createToolRegistry({ tools: [example({ execute: function () { calls++; return { value: 1 }; } })] });
  for (var args of [null, [], {}, { count: '1' }, { count: 0 }, { count: 1.5 }, { count: 6 },
    { count: 1, extra: true }, { count: 1, nested: [1] }, { count: 1, nested: ['a', 'b', 'c'] }]) {
    assert.equal((await registry.executeTool('example', args)).code, 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
  await registry.dispose();
});

test('schema validates output and finite JSON, errors bypass success schema but remain bounded', async function () {
  for (var result of [{ value: 'wrong' }, { value: NaN }, undefined, new Date(), { value: 1, extra: true }, { value: Infinity }]) {
    var registry = createToolRegistry({ tools: [example({ execute: function () { return result; } })] });
    assert.equal((await registry.executeTool('example', { count: 1 })).code, 'INVALID_OUTPUT');
    await registry.dispose();
  }
  var errorRegistry = createToolRegistry({ tools: [example({ execute: function () { return { error: 'upstream unavailable' }; } })] });
  var value = await errorRegistry.executeTool('example', { count: 1 });
  assert.deepEqual(value, { error: 'upstream unavailable' });
  assert.equal(errorRegistry.renderToolResult('example', {}, value), JSON.stringify(value));
  assert.equal(errorRegistry.getToolPresentationMeta('example', {}, value), null);
  await errorRegistry.dispose();
});

test('bounds JSON byte size, nested structures, circular values, and render/presentation outputs', async function () {
  var registry = createToolRegistry({ maxInputBytes: 1024, maxOutputBytes: 128, tools: [example()] });
  assert.equal((await registry.executeTool('example', { count: 1, nested: ['中'.repeat(500)] })).code, 'INVALID_INPUT');
  for (var sparse of [new Array(200000000), new Array(2)]) {
    assert.equal((await registry.executeTool('example', { count: 1, nested: sparse })).code, 'INVALID_INPUT');
  }
  var circular = {}; circular.self = circular;
  assert.equal((await registry.executeTool('example', circular)).code, 'INVALID_INPUT');
  var nested = {}; var cursor = nested;
  for (var i = 0; i < 50; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.equal((await registry.executeTool('example', nested)).code, 'INVALID_INPUT');
  registry.registerTool(example({ name: 'huge', execute: function () { return { error: 'x'.repeat(129) }; } }));
  assert.equal((await registry.executeTool('huge', { count: 1 })).code, 'INVALID_OUTPUT');
  registry.registerTool(example({ name: 'render', output: { render: function () { return 'x'.repeat(129); }, presentationMeta: function () { return { x: 'x'.repeat(129) }; } } }));
  assert.throws(function () { registry.renderToolResult('render', {}, {}); }, /超过/);
  assert.throws(function () { registry.getToolPresentationMeta('render', {}, {}); }, /大小/);
  assert.equal(registry.renderToolResult('example', { count: 1 }, { value: 2 }), 'Value: 2');
  assert.deepEqual(registry.getToolPresentationMeta('example', {}, { value: 2 }), { label: '2' });
  await registry.dispose();
});

test('deadline aborts cooperative work and caller cannot raise configured timeout', async function () {
  var seenSignal;
  var registry = createToolRegistry({ timeoutMs: 15, tools: [example({ execute: function (args, context) {
    seenSignal = context.signal;
    assert.equal(context.timeoutMs, 15);
    return new Promise(function (resolve) { context.signal.addEventListener('abort', function () { resolve({ value: 0 }); }, { once: true }); });
  } })] });
  var result = await registry.executeTool('example', { count: 1 }, { timeoutMs: 999999 });
  assert.equal(result.code, 'TOOL_TIMEOUT');
  assert.equal(seenSignal.aborted, true);
  await registry.dispose();
});

test('external cancellation propagates, pre-cancelled calls never execute', async function () {
  var controller = new AbortController();
  var calls = 0;
  var registry = createToolRegistry({ tools: [example({ execute: function (args, context) {
    calls++;
    assert.equal(context.userId, 'owner');
    return new Promise(function (resolve) {
      context.signal.addEventListener('abort', function () { resolve({ value: 0 }); }, { once: true });
      controller.abort(new Error('cancel'));
    });
  } })] });
  assert.equal((await registry.executeTool('example', { count: 1 }, { userId: 'owner', signal: controller.signal })).code, 'TOOL_CANCELLED');
  assert.equal((await registry.executeTool('example', { count: 1 }, { signal: controller.signal })).code, 'TOOL_CANCELLED');
  assert.equal(calls, 1);
  await registry.dispose();
});

test('non-cooperative timeouts retain concurrency slots until the underlying work settles', async function () {
  var settle;
  var registry = createToolRegistry({ maxConcurrent: 1, timeoutMs: 10, tools: [example({ execute: function () {
    return new Promise(function (resolve) { settle = resolve; });
  } })] });
  assert.equal((await registry.executeTool('example', { count: 1 })).code, 'TOOL_TIMEOUT');
  assert.equal((await registry.executeTool('example', { count: 1 })).code, 'TOOL_BUSY');
  settle({ value: 1 });
  await new Promise(function (resolve) { setImmediate(resolve); });
  await registry.unregisterTool('example');
  registry.registerTool(example());
  assert.deepEqual(await registry.executeTool('example', { count: 1 }), { value: 2 });
  await registry.dispose();
});

test('unregister cancels active execution, disposes once, and stale handles cannot remove replacements', async function () {
  var started;
  var ready = new Promise(function (resolve) { started = resolve; });
  var disposed = 0;
  var registry = createToolRegistry();
  var remove = registry.registerTool(example({ execute: function (args, context) {
    started();
    return new Promise(function (resolve) { context.signal.addEventListener('abort', function () { resolve({ value: 0 }); }, { once: true }); });
  }, dispose: function () { disposed++; } }));
  var pending = registry.executeTool('example', { count: 1 });
  await ready;
  assert.equal(await remove(), true);
  assert.equal((await pending).code, 'TOOL_CANCELLED');
  assert.equal(disposed, 1);
  registry.registerTool(example());
  assert.equal(await remove(), false);
  assert.equal(registry.hasTool('example'), true);
  await registry.dispose();
  await registry.dispose();
  assert.throws(function () { registry.registerTool(example()); }, /卸载/);
});

test('dispose attempts every cleanup even if one plugin throws', async function () {
  var cleaned = [];
  var registry = createToolRegistry({ tools: [example({ dispose: function () { cleaned.push('first'); throw new Error('cleanup'); } }),
    example({ name: 'second', dispose: function () { cleaned.push('second'); } })] });
  await assert.rejects(registry.dispose(), AggregateError);
  assert.deepEqual(cleaned, ['first', 'second']);
  assert.deepEqual(registry.getToolDefinitions(), []);
});
