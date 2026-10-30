import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

var directory = mkdtempSync(join(tmpdir(), 'threadthink-annotation-reply-'));
process.env.DB_PATH = join(directory, 'test.db');
process.env.JWT_SECRET = 'annotation-reply-secret';
process.env.ENCRYPTION_SECRET = 'annotation-reply-encryption-secret-long';
var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var { recordMessage, replayConversation, rollbackConversation } = await import('../src/services/events.service.js');
var { buildAnnotationContext } = await import('../src/services/annotation.service.js');
var app, number = 0, originalFetch = globalThis.fetch;
before(async function () { app = await buildApp(); });
after(async function () { globalThis.fetch = originalFetch; await app.close(); closeDb(); rmSync(directory, { recursive: true, force: true }); });

async function fixture() {
  number++;
  var auth = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'reply' + number + '@test.com', password: 'password123' } })).json();
  var headers = { authorization: 'Bearer ' + auth.token };
  var conversation = (await app.inject({ method: 'POST', url: '/api/conversations', headers: headers, payload: { title: 'annotations' } })).json().conversation;
  await app.inject({ method: 'PUT', url: '/api/settings', headers: headers, payload: { apiKey: 'mock-key', apiBase: 'https://provider.test/v1/chat/completions', model: 'mock-model' } });
  var userId = getDb().prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversation.id).user_id;
  recordMessage(userId, conversation.id, { role: 'user', content: '早期问题' });
  var message = recordMessage(userId, conversation.id, { role: 'assistant', content: '原回答：向量检索使用余弦相似度。' });
  var created = await app.inject({ method: 'POST', url: '/api/annotations', headers: headers,
    payload: { messageId: message.id, selectedText: '余弦相似度', question: '支线唯一问题' } });
  assert.equal(created.statusCode, 201, created.body);
  return { headers: headers, userId: userId, conversationId: conversation.id, message: message, annotation: created.json().annotation };
}

function provider(output, inspect) {
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    if (inspect) inspect(body);
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: output } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
}

test('annotation reply persists answer and audit messages without contaminating main context', async function () {
  var f = await fixture();
  provider('支线唯一答案');
  var reply = await app.inject({ method: 'POST', url: '/api/annotations/' + f.annotation.id + '/reply', headers: f.headers, payload: {} });
  assert.equal(reply.statusCode, 200);
  assert.match(reply.body, /event: done/);
  assert.equal(getDb().prepare('SELECT answer FROM annotations WHERE id = ?').get(f.annotation.id).answer, '支线唯一答案');
  var audit = getDb().prepare("SELECT * FROM messages WHERE annotation_id = ? AND kind = 'annotation'").all(f.annotation.id);
  assert.equal(audit.length, 2);
  var listed = (await app.inject({ method: 'GET', url: '/api/conversations/' + f.conversationId + '/messages', headers: f.headers })).json();
  assert.equal(listed.messages.length, 2);
  var outgoing = [];
  provider('主线新答案', function (body) { outgoing.push(JSON.stringify(body.messages)); });
  var main = await app.inject({ method: 'POST', url: '/api/chat/stream', headers: f.headers, payload: { conversationId: f.conversationId, message: '继续主线' } });
  assert.match(main.body, /event: done/);
  assert.ok(outgoing.length > 0);
  outgoing.forEach(function (input) { assert.doesNotMatch(input, /支线唯一答案|支线唯一问题/); });
  assert.equal(replayConversation(f.userId, f.conversationId).annotations[0].answer, '支线唯一答案');
});

test('child annotation context contains ancestors, source and history only through target', async function () {
  var f = await fixture();
  provider('父批注的回答');
  await app.inject({ method: 'POST', url: '/api/annotations/' + f.annotation.id + '/reply', headers: f.headers, payload: {} });
  recordMessage(f.userId, f.conversationId, { role: 'user', content: '不应出现在批注上下文的未来消息' });
  var response = await app.inject({ method: 'POST', url: '/api/annotations', headers: f.headers,
    payload: { messageId: f.message.id, parentId: f.annotation.id, selectedText: '父批注的回答', question: '再问一步' } });
  assert.equal(response.statusCode, 201, response.body);
  var context = await buildAnnotationContext(f.userId, response.json().annotation.id);
  var text = JSON.stringify(context.messages);
  assert.match(text, /原回答/);
  assert.match(text, /父批注的回答/);
  assert.doesNotMatch(text, /未来消息/);
  assert.equal(response.json().annotation.parent_id, f.annotation.id);
});

test('annotation updates are recorded and parent/reply ownership is checked', async function () {
  var owner = await fixture(), outsider = await fixture();
  var changed = await app.inject({ method: 'PUT', url: '/api/annotations/' + owner.annotation.id, headers: owner.headers, payload: { question: '修改的问题', status: 'outdated' } });
  assert.equal(changed.statusCode, 200);
  assert.equal(replayConversation(owner.userId, owner.conversationId).annotations[0].status, 'outdated');
  for (var method of ['PUT', 'POST']) {
    var response = await app.inject({ method: method, url: '/api/annotations/' + owner.annotation.id + (method === 'POST' ? '/reply' : ''), headers: outsider.headers, payload: { status: 'resolved' } });
    assert.equal(response.statusCode, 404);
  }
  var parent = await app.inject({ method: 'POST', url: '/api/annotations', headers: owner.headers, payload: { messageId: owner.message.id, parentId: outsider.annotation.id, question: '越权子批注' } });
  assert.equal(parent.statusCode, 404);
});

test('rollback hides annotations and blocks replies to hidden messages without deleting records', async function () {
  var f = await fixture();
  rollbackConversation(f.userId, f.conversationId, 0);
  var response = await app.inject({ method: 'POST', url: '/api/annotations/' + f.annotation.id + '/reply', headers: f.headers, payload: {} });
  assert.equal(response.statusCode, 404);
  assert.ok(getDb().prepare('SELECT id FROM annotations WHERE id = ?').get(f.annotation.id));
  assert.deepEqual(replayConversation(f.userId, f.conversationId).annotations, []);
});

test('long answers preserve the selected tail paragraph inside the source budget', async function () {
  var f = await fixture();
  var message = recordMessage(f.userId, f.conversationId, { role: 'assistant', content: '较早的无关介绍。'.repeat(2000) + '\n\n目标段落：重要的尾部事实，解释了最终结论。\n\n相邻补充段落。' });
  var created = await app.inject({ method: 'POST', url: '/api/annotations', headers: f.headers,
    payload: { messageId: message.id, selectedText: '重要的尾部事实', question: '这个结论从何而来？' } });
  assert.equal(created.statusCode, 201);
  var context = await buildAnnotationContext(f.userId, created.json().annotation.id);
  var source = context.sections.find(function (section) { return section.id === 'source'; });
  assert.match(source.content, /重要的尾部事实/);
  assert.match(source.content, /相邻补充段落/);
  assert.ok(source.tokens <= source.maxTokens);
  var empty = await app.inject({ method: 'POST', url: '/api/annotations', headers: f.headers, payload: { messageId: message.id, selectedText: '  ', question: 'x' } });
  assert.equal(empty.statusCode, 400);
});

test('invalid anchor offsets and invalid states fail before writing events', async function () {
  var f = await fixture();
  var response = await app.inject({ method: 'POST', url: '/api/annotations', headers: f.headers,
    payload: { messageId: f.message.id, question: 'x', startOffset: -1, endOffset: 2 } });
  assert.equal(response.statusCode, 400);
  var update = await app.inject({ method: 'PUT', url: '/api/annotations/' + f.annotation.id, headers: f.headers, payload: { status: 'gone' } });
  assert.equal(update.statusCode, 400);
});
