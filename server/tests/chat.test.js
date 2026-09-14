import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

var tempDir = mkdtempSync(join(tmpdir(), 'threadthink-chat-'));
process.env.DB_PATH = join(tempDir, 'chat.db');
process.env.UPLOAD_DIR = join(tempDir, 'uploads');
process.env.JWT_SECRET = 'chat-test-secret';
process.env.ENCRYPTION_SECRET = 'chat-test-encryption-key-32chars!!';

var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var app;

before(async function () { app = await buildApp({ logger: false }); });
beforeEach(function () {
  getDb().exec('DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM conversations; DELETE FROM chunks; DELETE FROM documents; DELETE FROM user_settings; DELETE FROM users;');
});
after(async function () { await app.close(); closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

async function setup(apiBase, model) {
  var registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'chat@example.com', password: 'password123' } });
  assert.equal(registered.statusCode, 200);
  var token = registered.json().token;
  var conversationResponse = await app.inject({
    method: 'POST', url: '/api/conversations', headers: { authorization: 'Bearer ' + token },
    payload: { title: '原始标题' },
  });
  assert.equal(conversationResponse.statusCode, 201);
  var conversation = conversationResponse.json().conversation;
  var settings = await app.inject({
    method: 'PUT', url: '/api/settings', headers: { authorization: 'Bearer ' + token },
    payload: { apiKey: 'offline-key', apiBase: apiBase || 'https://provider.test/v1/chat/completions', model: model || 'offline-model' },
  });
  assert.equal(settings.statusCode, 200);
  return { token: token, conversationId: conversation.id };
}

function sseResponse(parts, options) {
  var encoder = new TextEncoder();
  var index = 0;
  var opts = options || {};
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < parts.length) controller.enqueue(typeof parts[index] === 'string' ? encoder.encode(parts[index++]) : parts[index++]);
      else if (opts.reject) controller.error(new Error(opts.reject));
      else controller.close();
    },
    cancel() { if (opts.onCancel) opts.onCancel(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function openAiText(text, terminal) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n' + (terminal === false ? '' : 'data: [DONE]\n\n');
}

function dbMessages(id) { return getDb().prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid').all(id); }
function dbToolCalls() { return getDb().prepare('SELECT tool_name, arguments, result, status FROM tool_calls ORDER BY rowid').all(); }

 test('provider HTTP errors become one SSE error and do not persist assistant', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  globalThis.fetch = async function () { return new Response('upstream exploded', { status: 503 }); };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '错误测试' } });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body.match(/event: error/g) || []).length, 1);
    assert.equal((response.body.match(/event: done/g) || []).length, 0);
    assert.equal(dbMessages(ctx.conversationId).filter(function (m) { return m.role === 'assistant'; }).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('partial tokens followed by reader rejection emit error without assistant persistence', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    if (JSON.parse(options.body).stream === false) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'probe' } }] }), { status: 200 });
    return sseResponse([new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')], { reject: 'reader failed' });
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '部分失败' } });
    assert.match(response.body, /部分/);
    assert.match(response.body, /event: error/);
    assert.doesNotMatch(response.body, /event: done/);
    assert.equal(dbMessages(ctx.conversationId).filter(function (m) { return m.role === 'assistant'; }).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('EOF without terminal emits error and final block with terminal succeeds', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    calls++;
    var body = JSON.parse(options.body);
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'probe' } }] }), { status: 200 });
    if (calls === 2) return sseResponse(['data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n']);
    return sseResponse(['data: {"choices":[{"delta":{"content":"完成"}}]}\r\n\r\ndata: [DONE]\r\n\r\n']);
  };
  try {
    var failed = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: 'EOF失败' } });
    assert.match(failed.body, /未完成/);
    assert.match(failed.body, /event: error/);
    assert.equal(dbMessages(ctx.conversationId).filter(function (m) { return m.role === 'assistant'; }).length, 0);

    var successful = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: 'EOF成功' } });
    assert.match(successful.body, /完成/);
    assert.equal((successful.body.match(/event: done/g) || []).length, 1);
    assert.equal((successful.body.match(/event: error/g) || []).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('SSE parser handles optional data space, multiline JSON, UTF-8 boundaries, and provider error event', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var encoder = new TextEncoder();
  var utf8 = encoder.encode('data: {"choices":[{"delta":{"content":"多字"}}]}\n\n');
  globalThis.fetch = async function (url, options) {
    if (!JSON.parse(options.body).stream) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'probe' } }] }), { status: 200 });
    return sseResponse([utf8.slice(0, utf8.length - 1), utf8.slice(utf8.length - 1), 'data:{"choices":[{"delta":{"content":"符号"}}]}\r\n\r\ndata:[DONE]\r\n\r\n']);
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '解析' } });
    assert.match(response.body, /多字/);
    assert.match(response.body, /符号/);
    assert.equal((response.body.match(/event: done/g) || []).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('tool success records audit entries and returns final answer', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (!body.stream) {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2 + 3"}' } }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '工具结果是 5' } }] }), { status: 200 });
    }
    return new Response(openAiText('工具结果是 5'), { status: 200 });
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '算一下' } });
    assert.match(response.body, /工具结果是 5/);
    assert.equal(dbToolCalls().length, 1);
    assert.equal(dbToolCalls()[0].tool_name, 'calculator');
    assert.equal(dbToolCalls()[0].status, 'done');
    assert.equal(dbToolCalls()[0].result.includes('5'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown and malformed tool arguments are returned as audited tool errors', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (!body.stream) {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
        { id: 'unknown', type: 'function', function: { name: 'not_registered', arguments: '{"x":1}' } },
        { id: 'malformed', type: 'function', function: { name: 'calculator', arguments: '{bad' } },
      ] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '已处理错误' } }] }), { status: 200 });
    }
    return new Response(openAiText('已处理错误'), { status: 200 });
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '坏工具' } });
    assert.match(response.body, /已处理错误/);
    var audits = dbToolCalls();
    assert.equal(audits.length, 2);
    assert.equal(audits[0].status, 'error');
    assert.equal(audits[1].status, 'error');
    assert.match(audits[0].result, /未知工具/);
    assert.match(audits[1].result, /参数无效/);
  } finally { globalThis.fetch = originalFetch; }
});

test('tool rounds are bounded at five before fallback response', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var nonstream = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (!body.stream) {
      nonstream++;
      if (nonstream <= 5) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'round-' + nonstream, type: 'function', function: { name: 'calculator', arguments: '{"expression":"1"}' } }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '达到上限' } }] }), { status: 200 });
    }
    throw new Error('stream should not be used for fallback');
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '循环工具' } });
    assert.match(response.body, /达到上限/);
    assert.equal(nonstream, 6);
    assert.equal(dbToolCalls().length, 5);
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic tool_use then text uses exact hostname and consolidates tool results', async function () {
  var ctx = await setup('https://api.anthropic.com/v1/messages', 'claude-test');
  var originalFetch = globalThis.fetch;
  var nonstream = 0;
  var requests = [];
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    requests.push(body);
    if (!body.stream) {
      nonstream++;
      if (nonstream === 1) return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'a1', name: 'calculator', input: { expression: '4 + 4' } },
        { type: 'tool_use', id: 'a2', name: 'calculator', input: { expression: '5 + 5' } },
      ] }), { status: 200 });
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anthropic完成' }] }), { status: 200 });
    }
    return new Response('data: {"type":"content_block_delta","delta":{"text":"Anthropic完成"}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n', { status: 200 });
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: 'Anthropic工具' } });
    assert.match(response.body, /Anthropic完成/);
    assert.equal(dbToolCalls().length, 2);
    var second = requests[1];
    assert.equal(second.messages.filter(function (m) { return m.role === 'user' && Array.isArray(m.content); }).length, 1);
    assert.equal(second.messages.filter(function (m) { return m.role === 'user' && Array.isArray(m.content); })[0].content.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic hostname matching does not classify lookalike hosts as Anthropic', async function () {
  var ctx = await setup('https://api.anthropic.com.example.test/v1/chat/completions');
  var originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'probe' } }] }), { status: 200 });
    assert.equal(options.headers.Authorization, 'Bearer offline-key');
    assert.equal(options.headers['x-api-key'], undefined);
    return new Response(openAiText('OpenAI形状'), { status: 200 });
  };
  try {
    var response = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: ctx.conversationId, message: '主机名' } });
    assert.match(response.body, /OpenAI形状/);
  } finally { globalThis.fetch = originalFetch; }
});

test('conversationId must be a string and ownership is checked before provider access', async function () {
  var ctx = await setup();
  var originalFetch = globalThis.fetch;
  var fetched = false;
  globalThis.fetch = async function () { fetched = true; throw new Error('must not fetch'); };
  try {
    var badType = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: { bad: true }, message: 'x' } });
    assert.equal(badType.statusCode, 400);
    var missing = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + ctx.token }, payload: { conversationId: 'not-owned', message: 'x' } });
    assert.equal(missing.statusCode, 404);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});
