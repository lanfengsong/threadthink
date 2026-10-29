import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

var tempDir = mkdtempSync(join(tmpdir(), 'threadthink-annotations-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.JWT_SECRET = 'annotations-test-secret';
process.env.ENCRYPTION_SECRET = 'annotations-test-encryption-key-32chars';

var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var app;
var userNumber = 0;

before(async function () { app = await buildApp({ logger: false }); });
beforeEach(function () {
  getDb().exec('DELETE FROM annotations; DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM conversations; DELETE FROM chunks; DELETE FROM documents; DELETE FROM user_settings; DELETE FROM users;');
});
after(async function () {
  await app.close(); closeDb(); rmSync(tempDir, { recursive: true, force: true });
});

async function register() {
  userNumber++;
  var result = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'ann' + userNumber + '@example.com', password: 'password123' } });
  assert.equal(result.statusCode, 200);
  return result.json();
}

async function createConversation(token) {
  var result = await app.inject({ method: 'POST', url: '/api/conversations', headers: { authorization: 'Bearer ' + token }, payload: { title: 't' } });
  assert.equal(result.statusCode, 201);
  return result.json().conversation.id;
}

function insertMessage(conversationId, role, content) {
  getDb().prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)')
    .run('msg-' + conversationId + '-' + role + '-' + Math.random().toString(36).slice(2, 8), conversationId, role, content);
  return getDb().prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId).pop().id;
}

test('creates an annotation with the full anchor payload', async function () {
  var auth = await register();
  var convId = await createConversation(auth.token);
  var msgId = insertMessage(convId, 'assistant', '这是一段用于批注的回答内容。');

  var res = await app.inject({
    method: 'POST', url: '/api/annotations',
    headers: { authorization: 'Bearer ' + auth.token },
    payload: {
      messageId: msgId, blockId: 'b1a2b3c4', startOffset: 3, endOffset: 7,
      selectedText: '用于批注', textHash: 'abc123', rawContext: '段用于批注的', question: '为什么？',
    },
  });
  assert.equal(res.statusCode, 201);
  var ann = res.json().annotation;
  assert.equal(ann.message_id, msgId);
  assert.equal(ann.block_id, 'b1a2b3c4');
  assert.equal(ann.start_offset, 3);
  assert.equal(ann.end_offset, 7);
  assert.equal(ann.question, '为什么？');
  assert.equal(ann.status, 'active');
});

test('rejects annotation on another user\'s message (IDOR) and on bad input', async function () {
  var alice = await register();
  var bob = await register();
  var convId = await createConversation(alice.token);
  var msgId = insertMessage(convId, 'assistant', 'alice 的私有回答');

  var idor = await app.inject({
    method: 'POST', url: '/api/annotations',
    headers: { authorization: 'Bearer ' + bob.token },
    payload: { messageId: msgId, question: '越权追问' },
  });
  assert.equal(idor.statusCode, 404);

  var missing = await app.inject({
    method: 'POST', url: '/api/annotations',
    headers: { authorization: 'Bearer ' + alice.token },
    payload: { messageId: msgId },
  });
  assert.equal(missing.statusCode, 400);

  var noAuth = await app.inject({ method: 'POST', url: '/api/annotations', payload: { question: 'x' } });
  assert.equal(noAuth.statusCode, 401);
});

test('lists annotations per conversation with ownership checks', async function () {
  var alice = await register();
  var bob = await register();
  var convId = await createConversation(alice.token);
  var msgId = insertMessage(convId, 'assistant', '第一个回答。\n\n第二个回答。');

  await app.inject({
    method: 'POST', url: '/api/annotations',
    headers: { authorization: 'Bearer ' + alice.token },
    payload: { messageId: msgId, blockId: 'bx', startOffset: 1, endOffset: 2, selectedText: '一', question: '其一' },
  });
  await app.inject({
    method: 'POST', url: '/api/annotations',
    headers: { authorization: 'Bearer ' + alice.token },
    payload: { messageId: msgId, blockId: 'by', startOffset: 0, endOffset: 2, selectedText: '第二', question: '其二' },
  });

  var list = await app.inject({ method: 'GET', url: '/api/annotations?conversationId=' + convId, headers: { authorization: 'Bearer ' + alice.token } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().annotations.length, 2);
  assert.deepEqual(list.json().annotations.map(function (a) { return a.question; }), ['其一', '其二']);

  var forbidden = await app.inject({ method: 'GET', url: '/api/annotations?conversationId=' + convId, headers: { authorization: 'Bearer ' + bob.token } });
  assert.equal(forbidden.statusCode, 404);

  var badQuery = await app.inject({ method: 'GET', url: '/api/annotations', headers: { authorization: 'Bearer ' + alice.token } });
  assert.equal(badQuery.statusCode, 400);
});