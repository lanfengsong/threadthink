import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

var tempDir = mkdtempSync(join(tmpdir(), 'threadthink-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_SECRET = 'test-encryption-key-32chars!!';

var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');

var app;

before(async function () {
  app = await buildApp({ logger: false });
});

beforeEach(function () {
  var db = getDb();
  db.exec('DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM conversations; DELETE FROM chunks; DELETE FROM documents; DELETE FROM user_settings; DELETE FROM users;');
});

after(async function () {
  await app.close();
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

async function register(email, password) {
  var response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: email, password: password || 'password123' },
  });
  assert.equal(response.statusCode, 200);
  return response.json();
}

async function createConversation(token, title) {
  var response = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: { authorization: 'Bearer ' + token },
    payload: { title: title || '测试对话' },
  });
  assert.equal(response.statusCode, 201);
  return response.json().conversation;
}

test('health endpoint is public and returns an ISO timestamp', async function () {
  var response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  var body = response.json();
  assert.equal(body.status, 'ok');
  assert.doesNotThrow(function () { new Date(body.time).toISOString(); });
});

test('registration validates credentials and prevents duplicates', async function () {
  var result = await register('alice@example.com');
  assert.ok(result.token);
  assert.equal(result.user.email, 'alice@example.com');

  var duplicate = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(duplicate.statusCode, 409);

  var invalid = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'not-an-email', password: '123' },
  });
  assert.equal(invalid.statusCode, 400);
});

test('login succeeds and rejects bad credentials', async function () {
  await register('alice@example.com', 'password123');
  var login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'alice@example.com', password: 'password123' },
  });
  assert.equal(login.statusCode, 200);
  assert.ok(login.json().token);

  var bad = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'alice@example.com', password: 'wrong123' },
  });
  assert.equal(bad.statusCode, 401);
});

test('protected endpoints require a bearer token', async function () {
  var response = await app.inject({ method: 'GET', url: '/api/conversations' });
  assert.equal(response.statusCode, 401);
});

test('conversation resources are isolated between users', async function () {
  var alice = await register('alice@example.com');
  var bob = await register('bob@example.com');
  var conversation = await createConversation(alice.token, 'Alice private');

  var list = await app.inject({
    method: 'GET', url: '/api/conversations',
    headers: { authorization: 'Bearer ' + bob.token },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().conversations, []);

  var messages = await app.inject({
    method: 'GET', url: '/api/conversations/' + conversation.id + '/messages',
    headers: { authorization: 'Bearer ' + bob.token },
  });
  assert.equal(messages.statusCode, 404);

  var deletion = await app.inject({
    method: 'DELETE', url: '/api/conversations/' + conversation.id,
    headers: { authorization: 'Bearer ' + bob.token },
  });
  assert.equal(deletion.statusCode, 404);
});

test('chat rejects a conversation owned by another user before opening SSE', async function () {
  var alice = await register('alice@example.com');
  var bob = await register('bob@example.com');
  var conversation = await createConversation(alice.token);

  var response = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    headers: { authorization: 'Bearer ' + bob.token },
    payload: { conversationId: conversation.id, message: '越权消息' },
  });
  assert.equal(response.statusCode, 404);
  assert.match(response.body, /对话不存在/);
});

test('chat streams provider output and persists the exact streamed text', async function () {
  var alice = await register('alice@example.com');
  var conversation = await createConversation(alice.token);
  var settings = await app.inject({
    method: 'PUT', url: '/api/settings',
    headers: { authorization: 'Bearer ' + alice.token },
    payload: { apiKey: 'test-api-key', apiBase: 'https://provider.test/chat/completions', model: 'test-model' },
  });
  assert.equal(settings.statusCode, 200);

  var originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'unused' } }] }), { status: 200 });
    }
    var encoder = new TextEncoder();
    var chunks = [
      encoder.encode('data: {"choices":[{"delta":{"content":"真实"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n'),
    ];
    var index = 0;
    return new Response(new ReadableStream({
      pull: function (controller) {
        if (index === chunks.length) { controller.close(); return; }
        controller.enqueue(chunks[index++]);
      },
    }), { status: 200 });
  };

  try {
    var response = await app.inject({
      method: 'POST', url: '/api/chat/stream',
      headers: { authorization: 'Bearer ' + alice.token },
      payload: { conversationId: conversation.id, message: '测试流式回答' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /真实/);
    assert.match(response.body, /回答/);
    var saved = getDb().prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation.id);
    assert.equal(saved.length, 2);
    assert.equal(saved[1].content, '真实回答');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat validates empty message', async function () {
  var alice = await register('alice@example.com');
  var conversation = await createConversation(alice.token);
  var response = await app.inject({
    method: 'POST', url: '/api/chat/stream',
    headers: { authorization: 'Bearer ' + alice.token },
    payload: { conversationId: conversation.id, message: '   ' },
  });
  assert.equal(response.statusCode, 400);
});
