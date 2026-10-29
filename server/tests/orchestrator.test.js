import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

var tempDir = mkdtempSync(join(tmpdir(), 'threadthink-orchestrator-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.JWT_SECRET = 'orchestrator-test-secret';
process.env.ENCRYPTION_SECRET = 'orchestrator-test-encryption-key-32chars!';

var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var app;
var userNumber = 0;

before(async function () { app = await buildApp({ logger: false }); });
beforeEach(function () {
  getDb().exec('DELETE FROM agent_logs; DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM conversations; DELETE FROM chunks; DELETE FROM documents; DELETE FROM user_settings; DELETE FROM users;');
});
after(async function () { await app.close(); closeDb(); rmSync(tempDir, { recursive: true, force: true }); });

async function register() {
  userNumber++;
  var r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'orch' + userNumber + '@example.com', password: 'password123' } });
  var auth = r.json();
  var c = await app.inject({ method: 'POST', url: '/api/conversations', headers: { authorization: 'Bearer ' + auth.token }, payload: { title: 't' } });
  await app.inject({
    method: 'PUT', url: '/api/settings', headers: { authorization: 'Bearer ' + auth.token },
    payload: { apiKey: 'k', apiBase: 'https://provider.test/v1/chat/completions', model: 'm' },
  });
  return { token: auth.token, conversationId: c.json().conversation.id };
}

function sse(text) {
  var encoder = new TextEncoder();
  var parts = [encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'), encoder.encode('data: [DONE]\n\n')];
  var i = 0;
  return new Response(new ReadableStream({ pull: function (c) { if (i < parts.length) c.enqueue(parts[i++]); else c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolCallResponse(name, args, id) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: id || 'call_1', type: 'function', function: { name: name, arguments: JSON.stringify(args || {}) } }] }, finish_reason: 'tool_calls' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}


function stopResponse(text) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text || '' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function agentLogs(conversationId) {
  return getDb().prepare('SELECT seq, kind, detail FROM agent_logs WHERE conversation_id = ? ORDER BY seq ASC').all(conversationId);
}

test('工具失败触发反思注入，修正后继续并完成（日志含 retry/revise）', async function () {
  var auth = await register();
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (calls === 1) return toolCallResponse('calculator', { expression: '1/0' }); // 失败载荷
    if (calls === 2) return stopResponse(''); // 反思后：模型决定直接回答
    return sse('修正后的回答。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: '算一下 1/0' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /修正后的回答/);
  var logs = agentLogs(auth.conversationId);
  var kinds = logs.map(function (l) { return l.kind; });
  assert.deepEqual(kinds, ['request', 'tool_call', 'tool_result', 'retry', 'done']);
  assert.equal(JSON.parse(logs[2].detail).status, 'error');
  assert.equal(JSON.parse(logs[3].detail).action, 'revise');
  // 反思指令已注入消息：sync(工具)+sync(反思后 stop)+stream(最终)共 3 次
  assert.equal(calls, 3);
});

test('同一工具连续失败两次后注入放弃指令，不再死循环', async function () {
  var auth = await register();
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (calls <= 2) return toolCallResponse('calculator', { expression: 'bad(' }, 'call_' + calls);
    if (calls === 3) return stopResponse('');
    return sse('直接回答。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: '算' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /直接回答/);
  var logs = agentLogs(auth.conversationId);
  var retries = logs.filter(function (l) { return l.kind === 'retry'; });
  assert.equal(retries.length, 2);
  assert.equal(JSON.parse(retries[1].detail).action, 'give_up');
  var toolCalls = getDb().prepare('SELECT COUNT(*) AS n FROM tool_calls').get();
  assert.equal(toolCalls.n, 2); // 只执行了两次，未打满 5 轮
});

test('正常工具链：日志序列完整且 trace_id 一致', async function () {
  var auth = await register();
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (calls === 1) return toolCallResponse('calculator', { expression: '2+2' });
    if (calls === 2) return stopResponse('');
    return sse('结果是 4。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: '计算' },
  });
  assert.equal(res.statusCode, 200);
  var logs = agentLogs(auth.conversationId);
  assert.deepEqual(logs.map(function (l) { return l.kind; }), ['request', 'tool_call', 'tool_result', 'done']);
  assert.equal(JSON.parse(logs[1].detail).tool, 'calculator');
  assert.equal(JSON.parse(logs[2].detail).status, 'done');
  var traces = getDb().prepare('SELECT DISTINCT trace_id FROM agent_logs').all();
  assert.equal(traces.length, 1);
  var done = logs[logs.length - 1];
  assert.ok(JSON.parse(done.detail).rounds >= 1);
});
test('RAG 注入：用户有文档时，首个请求携带【相关资料】上下文', async function () {
  var auth = await register();
  var db = getDb();
  var userRow = db.prepare('SELECT id FROM users ORDER BY rowid DESC').get();
  db.prepare('INSERT INTO documents (id, user_id, filename, file_type, chunk_count) VALUES (?, ?, ?, ?, ?)').run('d1', userRow.id, 'a.txt', 'txt', 1);
  db.prepare('INSERT INTO chunks (id, document_id, chunk_index, content, embedding, section_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run('c1', 'd1', 0, 'ThreadThink 是批注式对话工具。', JSON.stringify([1, 0]), '概述');

  var injected = false;
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (Array.isArray(body.input)) { // embedding 调用
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
    }
    if (body.stream === false) { // sync：验证注入
      if (JSON.stringify(body.messages).indexOf('【相关资料】') !== -1) injected = true;
      return stopResponse('');
    }
    return sse('基于文档的回答。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: 'ThreadThink 是什么？' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(injected, true, '应注入【相关资料】');
  assert.match(res.body, /基于文档的回答/);
});

test('RAG 注入：无文档时零额外开销（无 embedding 调用）', async function () {
  var auth = await register();
  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (body.stream === false) return stopResponse('');
    return sse('无文档回答。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: '问个问题' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2, '无文档应只有 sync + stream 两次调用');
  assert.match(res.body, /无文档回答/);
});

test('RAG 注入：检索失败时静默降级，对话照常', async function () {
  var auth = await register();
  var db = getDb();
  var userRow = db.prepare('SELECT id FROM users ORDER BY rowid DESC').get();
  db.prepare('INSERT INTO documents (id, user_id, filename, file_type, chunk_count) VALUES (?, ?, ?, ?, ?)').run('d2', userRow.id, 'b.txt', 'txt', 1);
  db.prepare('INSERT INTO chunks (id, document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)')
    .run('c2', 'd2', 0, 'some content', JSON.stringify([1, 0]));

  var calls = 0;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    calls++;
    if (Array.isArray(body.input)) return new Response('down', { status: 500 }); // embedding 失败
    if (body.stream === false) return stopResponse('');
    return sse('降级后的回答。');
  };
  var res = await app.inject({
    method: 'POST', url: '/api/chat/stream', headers: { authorization: 'Bearer ' + auth.token },
    payload: { conversationId: auth.conversationId, message: '查资料' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /降级后的回答/);
});
