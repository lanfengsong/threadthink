import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

var temporary = mkdtempSync(join(tmpdir(), 'threadthink-event-stream-'));
process.env.DB_PATH = join(temporary, 'stream.db');
process.env.JWT_SECRET = 'event-stream-test';
process.env.ENCRYPTION_SECRET = 'event-stream-encryption-secret';
var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var { recordMessage, replayConversation } = await import('../src/services/events.service.js');
var app;
before(async () => { app = await buildApp({ logger: false }); });
after(async () => { await app.close(); closeDb(); rmSync(temporary, { recursive: true, force: true }); });

test('active generation blocks rollback/delete, allows a snapshot fork, and resumes from rolled back history', async () => {
  var registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'stream@example.com', password: 'password123' } });
  var { token, user } = registration.json();
  var headers = { authorization: 'Bearer ' + token };
  var created = await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} });
  var conversationId = created.json().conversation.id;
  var base = '/api/conversations/' + conversationId;
  await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { apiKey: 'offline-only', apiBase: 'https://provider.test/v1/chat/completions' } });
  var keep = recordMessage(user.id, conversationId, { role: 'assistant', content: '保留上下文' });
  recordMessage(user.id, conversationId, { role: 'assistant', content: '回退后不可见的秘密' });
  var previousFetch = globalThis.fetch;
  var signalEntered, release;
  var entered = new Promise(resolve => { signalEntered = resolve; });
  var gate = new Promise(resolve => { release = resolve; });
  var requests = [];
  globalThis.fetch = async (url, options) => {
    var body = JSON.parse(options.body);
    requests.push(body);
    signalEntered();
    await gate;
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }), { status: 200 });
  };
  var ongoing;
  try {
    ongoing = app.inject({ method: 'POST', url: '/api/chat/stream', headers, payload: { conversationId, message: '生成中' } });
    // Injection starts when consumed; keep it alive while exercising concurrent routes.
    ongoing = Promise.resolve(ongoing);
    await entered;
    var rollback = await app.inject({ method: 'POST', url: base + '/rollback', headers, payload: { seq: keep.seq } });
    var deletion = await app.inject({ method: 'DELETE', url: base, headers });
    var fork = await app.inject({ method: 'POST', url: base + '/fork', headers, payload: { seq: keep.seq } });
    assert.equal(rollback.statusCode, 409);
    assert.equal(deletion.statusCode, 409);
    assert.equal(fork.statusCode, 201);
    release();
    var response = await ongoing;
    assert.match(response.body, /event: done/);
    var applied = await app.inject({ method: 'POST', url: base + '/rollback', headers, payload: { seq: keep.seq } });
    assert.equal(applied.statusCode, 200);
    assert.deepEqual(replayConversation(user.id, conversationId).messages.map(message => message.content), ['保留上下文']);
    requests = [];
    var continued = await app.inject({ method: 'POST', url: '/api/chat/stream', headers, payload: { conversationId, message: '回退后继续' } });
    assert.match(continued.body, /event: done/);
    assert.match(JSON.stringify(requests), /保留上下文/);
    assert.doesNotMatch(JSON.stringify(requests), /回退后不可见的秘密|生成中/);
    var traces = await app.inject({ method: 'GET', url: base + '/traces', headers });
    var traceId = traces.json().traces.at(-1).trace_id;
    var replay = await app.inject({ method: 'POST', url: base + '/traces/' + traceId + '/replay', headers, payload: {} });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().mode, 'rerun');
    assert.equal(replay.json().consistent, true, JSON.stringify(replay.json().checks));
    assert.ok(getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId).n > replayConversation(user.id, conversationId).messages.length);
  } finally {
    release();
    if (ongoing) await ongoing;
    globalThis.fetch = previousFetch;
  }
});
