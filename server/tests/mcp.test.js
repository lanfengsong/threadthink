import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createToolRegistry } from '../src/services/tools/registry.js';
import { createMcpServer, MCP_PROTOCOL_VERSIONS } from '../src/services/tools/mcp.js';
import { mcpRoutes } from '../src/routes/mcp.routes.js';

function fixture(overrides) {
  return { name: 'double', description: 'Doubles a number',
    parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
      render: function (args, value) { return 'result=' + value.value; },
      presentationMeta: function (args, value) { return { kind: 'number', value: value.value }; } },
    execute: function (args) { return { value: args.n * 2 }; }, ...overrides };
}
function rpc(method, params, id) { return { jsonrpc: '2.0', id: id === undefined ? 1 : id, method: method, ...(params === undefined ? {} : { params: params }) }; }
var initialize = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

test('MCP initializes, negotiates versions, exports JSON schemas, and returns rendered/structured output', async function () {
  var registry = createToolRegistry({ tools: [fixture()] });
  var server = createMcpServer({ registry: registry });
  var init = await server.handle(initialize);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'threadthink');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  var unsupported = await server.handle(rpc('initialize', { ...initialize.params, protocolVersion: 'future-version' }));
  assert.equal(unsupported.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  var listed = await server.handle(rpc('tools/list'));
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].inputSchema.properties.n.type, 'integer');
  assert.equal(listed.result.tools[0].outputSchema.properties.value.type, 'integer');
  assert.equal(listed.result.tools[0].function, undefined);
  assert.equal(listed.result.tools[0].output, undefined);
  var result = await server.handle(rpc('tools/call', { name: 'double', arguments: { n: 3 } }, 'request-2'));
  assert.equal(result.id, 'request-2');
  assert.equal(result.result.isError, false);
  assert.deepEqual(result.result.content, [{ type: 'text', text: 'result=6' }]);
  assert.deepEqual(result.result.structuredContent, { value: 6 });
  assert.deepEqual(result.result._meta, { 'threadthink/presentation': { kind: 'number', value: 6 } });
  assert.deepEqual((await server.handle(rpc('ping'))).result, {});
  await registry.dispose();
});

test('MCP distinguishes protocol errors from tool failures and never executes notifications', async function () {
  var calls = 0;
  var registry = createToolRegistry({ tools: [fixture({ execute: function () { calls++; throw new Error('private stack'); } })] });
  var server = createMcpServer({ registry: registry });
  for (var entry of [
    ['{invalid', -32700], [null, -32600], [[], -32600], [rpc('ping', {}, null), -32600],
    [{ jsonrpc: '1.0', id: 1, method: 'ping' }, -32600], [rpc('missing'), -32601],
    [rpc('initialize', {}), -32602], [rpc('tools/list', { cursor: 'not-issued' }), -32602],
    [rpc('tools/call', { name: 'missing' }), -32602], [rpc('tools/call', { name: 'double', arguments: [] }), -32602],
    [rpc('tools/list', []), -32602], [rpc('notifications/initialized', {}), -32600],
  ]) assert.equal((await server.handle(entry[0])).error.code, entry[1], JSON.stringify(entry[0]));
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'double', arguments: { n: 2 } } }), null);
  assert.equal(calls, 0);
  var invalid = await server.handle(rpc('tools/call', { name: 'double', arguments: { n: '2' } }));
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent, undefined);
  assert.equal(calls, 0);
  var failed = await server.handle(rpc('tools/call', { name: 'double', arguments: { n: 2 } }));
  assert.equal(failed.result.isError, true);
  assert.equal(calls, 1);
  var oversized = await server.handle(rpc('tools/call', { name: 'double', arguments: { n: 'x'.repeat(65536) } }));
  assert.equal(oversized.error.code, -32600);
  await registry.dispose();
});

test('MCP output contract failures are tool errors with no invalid structured content', async function () {
  for (var tool of [fixture({ execute: function () { return { value: 'bad' }; } }),
    fixture({ output: { render: function () { throw new Error('secret renderer error'); } } })]) {
    var registry = createToolRegistry({ tools: [tool] });
    var server = createMcpServer({ registry: registry });
    var response = await server.handle(rpc('tools/call', { name: 'double', arguments: { n: 2 } }));
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent, undefined);
    assert.doesNotMatch(response.result.content[0].text, /secret/);
    await registry.dispose();
  }
});

test('MCP cancellation and duplicate IDs are scoped to authenticated caller', async function () {
  var signals = new Map();
  var starts = [];
  var registry = createToolRegistry({ tools: [fixture({ execute: function (args, context) {
    signals.set(context.userId, context.signal);
    for (var wake of starts.splice(0)) wake();
    return new Promise(function (resolve) { context.signal.addEventListener('abort', function () { resolve({ value: 0 }); }, { once: true }); });
  } })] });
  var server = createMcpServer({ registry: registry });
  var request = rpc('tools/call', { name: 'double', arguments: { n: 1 } }, 'same-id');
  var a = server.handle(request, { userId: 'a' });
  while (!signals.has('a')) await new Promise(function (resolve) { starts.push(resolve); });
  assert.equal((await server.handle(request, { userId: 'a' })).error.code, -32600);
  var b = server.handle(request, { userId: 'b' });
  while (!signals.has('b')) await new Promise(function (resolve) { starts.push(resolve); });
  var cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'same-id' } };
  await server.handle(cancel, { userId: 'outsider' });
  assert.equal(signals.get('a').aborted, false);
  assert.equal(signals.get('b').aborted, false);
  await server.handle(cancel, { userId: 'a' });
  assert.equal((await a).result.isError, true);
  assert.equal(signals.get('b').aborted, false);
  server.close();
  assert.equal((await b).result.isError, true);
  await registry.dispose();
});

async function httpApp(registry, extra) {
  var app = Fastify();
  app.decorateRequest('user', null);
  await app.register(mcpRoutes, { prefix: '/api/mcp', registry: registry,
    authenticate: async function (request, reply) {
      if (request.headers.authorization !== 'Bearer test') return reply.code(401).send({ error: 'Unauthorized' });
      request.user = { id: 'authenticated-user' };
    }, ...extra });
  await app.ready();
  return app;
}

function requestOptions(payload, headers) {
  return { method: 'POST', url: '/api/mcp', payload: payload,
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } };
}

test('MCP HTTP requires auth, applies Origin policy and has no persistent GET/SSE session', async function (t) {
  var registry = createToolRegistry({ tools: [fixture()] });
  var app = await httpApp(registry, { allowedOrigins: ['https://allowed.example'] });
  t.after(async function () { await app.close(); await registry.dispose(); });
  assert.equal((await app.inject({ method: 'POST', url: '/api/mcp', payload: initialize })).statusCode, 401);
  assert.equal((await app.inject(requestOptions(initialize, { origin: 'https://evil.example' }))).statusCode, 403);
  var good = await app.inject(requestOptions(initialize, { origin: 'https://allowed.example' }));
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().result.protocolVersion, '2025-06-18');
  assert.match(good.headers['content-type'], /application\/json/);
  for (var method of ['GET', 'DELETE']) {
    var response = await app.inject({ method: method, url: '/api/mcp', headers: { authorization: 'Bearer test' } });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'POST');
  }
  var notification = await app.inject(requestOptions({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.body, '');
});

test('MCP HTTP rejects malformed/oversized JSON and unsupported protocol/accept', async function (t) {
  var registry = createToolRegistry({ tools: [fixture()] });
  var app = await httpApp(registry);
  t.after(async function () { await app.close(); await registry.dispose(); });
  var malformed = await app.inject(requestOptions('{broken'));
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, -32700);
  var oversized = await app.inject(requestOptions(rpc('ping', { extra: 'x'.repeat(65536) })));
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, -32600);
  assert.equal((await app.inject(requestOptions(rpc('ping'), { 'mcp-protocol-version': 'unknown' }))).statusCode, 400);
  assert.equal((await app.inject(requestOptions(rpc('ping'), { accept: 'text/html' }))).statusCode, 406);
  assert.equal((await app.inject(requestOptions(JSON.stringify(rpc('ping')), { 'content-type': 'text/plain' }))).statusCode, 415);
});

test('MCP HTTP passes authenticated identity in context, never client arguments', async function (t) {
  var registry = createToolRegistry({ tools: [fixture({ parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: function (args, context) { assert.equal(context.userId, 'authenticated-user'); assert.equal(args.userId, 'attacker'); return { value: 7 }; } })] });
  var app = await httpApp(registry);
  t.after(async function () { await app.close(); await registry.dispose(); });
  var response = await app.inject(requestOptions(rpc('tools/call', { name: 'double', arguments: { userId: 'attacker' } })));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().result.structuredContent, { value: 7 });
});

test('MCP HTTP without auth integration fails closed', async function (t) {
  var app = Fastify();
  await app.register(mcpRoutes, { prefix: '/mcp', registry: createToolRegistry() });
  t.after(function () { return app.close(); });
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: initialize })).statusCode, 401);
});
