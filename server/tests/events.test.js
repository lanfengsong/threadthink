import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { migrate } from '../src/db/migrate.js';
import { runAgent } from '../../core/orchestrator.js';

var temporary = mkdtempSync(join(tmpdir(), 'threadthink-events-'));
process.env.DB_PATH = join(temporary, 'events.db');
process.env.JWT_SECRET = 'events-test-secret';
process.env.ENCRYPTION_SECRET = 'events-test-encryption-secret';
var { getDb, closeDb } = await import('../src/db/connection.js');
var { buildApp } = await import('../src/app.js');
var { appendEvent, recordMessage, listEvents, replayConversation, forkConversation, rollbackConversation, getTrace, replayTrace } = await import('../src/services/events.service.js');
var app;
before(async function () { app = await buildApp({ logger: false }); });
after(async function () { await app.close(); closeDb(); rmSync(temporary, { recursive: true, force: true }); });

function fixture() {
  var db = getDb();
  var userId = randomUUID(), conversationId = randomUUID();
  db.prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)').run(userId, userId + '@test.example', 'not-used');
  db.prepare('INSERT INTO conversations (id, user_id) VALUES (?, ?)').run(conversationId, userId);
  var token = jwt.sign({ sub: userId, email: userId + '@test.example' }, process.env.JWT_SECRET);
  return { db, userId, conversationId, headers: { authorization: 'Bearer ' + token } };
}

function annotation(ctx, message, parentId = null) {
  var id = randomUUID();
  ctx.db.prepare(`INSERT INTO annotations (id, message_id, selected_text, question, parent_id)
    VALUES (?, ?, ?, ?, ?)`).run(id, message.id, '引用', '为什么？', parentId);
  var row = ctx.db.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
  var event = appendEvent(ctx.userId, ctx.conversationId, 'annotation_created', { annotation: row });
  return { ...row, seq: event.seq };
}

function message(ctx, content, extra = {}) {
  return recordMessage(ctx.userId, ctx.conversationId, { role: 'assistant', content, ...extra });
}

function url(ctx, suffix) { return '/api/conversations/' + ctx.conversationId + suffix; }

test('event log rejects updates/deletes while compatibility-table cleanup retains immutable history', function () {
  var ctx = fixture();
  var original = message(ctx, '事实');
  assert.throws(() => ctx.db.prepare('INSERT OR REPLACE INTO events (seq,conversation_id,user_id,type,payload) VALUES (?,?,?,?,?)').run(original.seq, ctx.conversationId, ctx.userId, 'ai_message', '{}'), /append-only/);
  assert.throws(() => ctx.db.prepare('UPDATE events SET payload = ? WHERE conversation_id = ?').run('{}', ctx.conversationId), /append-only/);
  assert.throws(() => ctx.db.prepare('DELETE FROM events WHERE conversation_id = ?').run(ctx.conversationId), /append-only/);
  ctx.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(ctx.conversationId);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId).messages[0].content, '事实');
  ctx.db.prepare('DELETE FROM conversations WHERE id = ?').run(ctx.conversationId);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?').get(ctx.conversationId).n, 1);
});

test('canonical message and annotation views ignore mutable projection corruption', function () {
  var ctx = fixture();
  var first = message(ctx, '原回答');
  var ann = annotation(ctx, first);
  ctx.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('非法篡改', first.id);
  ctx.db.prepare('UPDATE annotations SET answer = ? WHERE id = ?').run('非法篡改', ann.id);
  var state = replayConversation(ctx.userId, ctx.conversationId);
  assert.equal(state.messages[0].content, '原回答');
  assert.equal(state.annotations[0].answer, '');
  assert.deepEqual(replayConversation(ctx.userId, ctx.conversationId, { upTo: state.headSeq }), state);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId, { upTo: first.seq }).annotations.length, 0);
});

test('rollback preserves all rows, restores historical annotation content, and accepts new continuation', function () {
  var ctx = fixture();
  var first = message(ctx, '第一条');
  var ann = annotation(ctx, first);
  var update = appendEvent(ctx.userId, ctx.conversationId, 'annotation_updated', { annotation: { ...ann, answer: '后来回答' } });
  var later = message(ctx, '后来消息');
  var reverted = rollbackConversation(ctx.userId, ctx.conversationId, ann.seq);
  assert.deepEqual(reverted.state.messages.map(m => m.id), [first.id]);
  assert.equal(reverted.state.annotations[0].answer, '');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(ctx.conversationId).n, 2);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId, { upTo: later.seq }).annotations[0].answer, '后来回答');
  assert.equal(replayConversation(ctx.userId, ctx.conversationId, { upTo: update.seq }).messages.length, 1);
  message(ctx, '新延续');
  assert.deepEqual(replayConversation(ctx.userId, ctx.conversationId).messages.map(m => m.content), ['第一条', '新延续']);
  var firstRollback = reverted.event.seq;
  rollbackConversation(ctx.userId, ctx.conversationId, 0);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId).messages.length, 0);
  rollbackConversation(ctx.userId, ctx.conversationId, firstRollback);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId).messages[0].content, '第一条');
});

test('fork remaps message/annotation trees and reply links without changing the source', function () {
  var ctx = fixture();
  var first = message(ctx, '分叉前');
  var root = annotation(ctx, first);
  var child = annotation(ctx, first, root.id);
  message(ctx, '旁路回答', { kind: 'annotation', annotation_id: child.id });
  var before = replayConversation(ctx.userId, ctx.conversationId);
  var eventsBefore = listEvents(ctx.userId, ctx.conversationId);
  var result = forkConversation(ctx.userId, ctx.conversationId, before.headSeq, { title: '新分支' });
  assert.deepEqual(replayConversation(ctx.userId, ctx.conversationId), before);
  assert.deepEqual(listEvents(ctx.userId, ctx.conversationId), eventsBefore);
  var branch = replayConversation(ctx.userId, result.conversation.id);
  assert.equal(branch.messages[0].id, result.idMap.messages[first.id]);
  assert.equal(branch.annotations[1].parent_id, result.idMap.annotations[root.id]);
  assert.equal(branch.messages[1].annotation_id, result.idMap.annotations[child.id]);
  assert.equal(branch.messages[1].kind, 'annotation');
  assert.equal(result.event.fork_from, before.headSeq);
  recordMessage(ctx.userId, result.conversation.id, { role: 'user', content: '新的问法' });
  assert.equal(replayConversation(ctx.userId, ctx.conversationId).messages.length, 2);
  assert.equal(replayConversation(ctx.userId, result.conversation.id).messages.length, 3);
});

test('fork remains replayable after source soft deletion and source rollback', async function () {
  var ctx = fixture();
  var first = message(ctx, '可独立保存');
  var branch = forkConversation(ctx.userId, ctx.conversationId, first.seq);
  rollbackConversation(ctx.userId, ctx.conversationId, 0);
  var deletion = await app.inject({ method: 'DELETE', url: url(ctx, ''), headers: ctx.headers });
  assert.equal(deletion.statusCode, 200);
  assert.equal(replayConversation(ctx.userId, branch.conversation.id).messages[0].content, '可独立保存');
  var deleted = await app.inject({ method: 'GET', url: url(ctx, '/replay'), headers: ctx.headers });
  assert.equal(deleted.statusCode, 404);
  assert.ok(ctx.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(first.id));
  assert.ok(ctx.db.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(ctx.conversationId).deleted_at);
});

test('annotation replies stay in audit replay but out of main messages API', async function () {
  var ctx = fixture();
  var first = message(ctx, '主线');
  var ann = annotation(ctx, first);
  message(ctx, '支线', { kind: 'annotation', annotation_id: ann.id });
  var response = await app.inject({ method: 'GET', url: url(ctx, '/messages'), headers: ctx.headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().messages.map(m => m.content), ['主线']);
  assert.equal(replayConversation(ctx.userId, ctx.conversationId).messages.length, 2);
  rollbackConversation(ctx.userId, ctx.conversationId, first.seq);
  assert.throws(() => message(ctx, '已回退批注', { kind: 'annotation', annotation_id: ann.id }), /批注不存在/);
});

test('history routes enforce authentication, ownership, and conversation-local seq/trace addressing', async function () {
  var alice = fixture(), bob = fixture();
  message(alice, '私密输入');
  var foreign = message(bob, '他人历史');
  appendEvent(alice.userId, alice.conversationId, 'request', { message: 'private' }, { traceId: 'private-trace' });
  for (var [method, path, payload] of [
    ['GET', '/events'], ['GET', '/replay'], ['GET', '/traces'], ['GET', '/traces/private-trace'],
    ['POST', '/traces/private-trace/replay', {}], ['POST', '/fork', { seq: 0 }], ['POST', '/rollback', { seq: 0 }],
  ]) {
    var anonymous = await app.inject({ method, url: url(alice, path), payload });
    assert.equal(anonymous.statusCode, 401, path);
    var denied = await app.inject({ method, url: url(alice, path), headers: bob.headers, payload });
    assert.equal(denied.statusCode, 404, path);
    assert.doesNotMatch(denied.body, /私密输入|private-trace/);
  }
  for (var path of ['/replay?upTo=' + foreign.seq, '/events?after=' + foreign.seq, '/replay?upTo=1.5', '/replay?upTo=-1', '/replay?upTo=abc']) {
    var invalid = await app.inject({ method: 'GET', url: url(alice, path), headers: alice.headers });
    assert.equal(invalid.statusCode, 400, path);
  }
  for (var path of ['/fork', '/rollback']) {
    var missing = await app.inject({ method: 'POST', url: url(alice, path), headers: alice.headers, payload: {} });
    assert.equal(missing.statusCode, 400);
  }
  assert.throws(() => appendEvent(bob.userId, alice.conversationId, 'request', {}), error => error.statusCode === 404);
  assert.throws(() => getTrace(bob.userId, alice.conversationId, 'private-trace'), error => error.statusCode === 404);
  assert.throws(() => appendEvent(alice.userId, alice.conversationId, 'rollback', { seq: 0 }), /专用/);
});

test('migration imports old JSON trees, metadata messages, tools, and traces once', function () {
  var db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.prepare('INSERT INTO users (id,email,password) VALUES (?,?,?)').run('old-user', 'old@example.com', 'x');
  db.prepare('INSERT INTO conversations (id,user_id) VALUES (?,?)').run('old-conversation', 'old-user');
  var legacy = [{ id: 'old-root', selectedText: '旧引用', question: '旧问题', answer: '旧回答', annotations: [{ question: '子问题', answer: '子回答' }] }];
  db.prepare('INSERT INTO messages (id,conversation_id,role,content,annotations) VALUES (?,?,?,?,?)').run('old-message', 'old-conversation', 'assistant', '旧正文', JSON.stringify(legacy));
  db.prepare('INSERT INTO tool_calls (id,message_id,tool_name,arguments,result,status) VALUES (?,?,?,?,?,?)').run('old-tool', 'old-message', 'calculator', '{"expression":"1"}', '{"value":1}', 'done');
  db.prepare('INSERT INTO agent_logs (id,conversation_id,trace_id,seq,kind,detail) VALUES (?,?,?,?,?,?)').run('old-log', 'old-conversation', 'old-trace', 0, 'request', '{"message":"旧请求"}');
  migrate(db);
  var before = db.prepare('SELECT * FROM events ORDER BY seq').all();
  assert.equal(before.length, 5);
  var rows = db.prepare('SELECT * FROM annotations ORDER BY rowid').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'old-root');
  assert.equal(rows[1].parent_id, 'old-root');
  assert.equal(rows[1].answer, '子回答');
  assert.equal(db.prepare('SELECT kind FROM messages').get().kind, 'chat');
  migrate(db);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM annotations ORDER BY rowid').all(), rows);
  db.close();
});

test('recordMessage rolls back its projection when event insertion fails', function () {
  var ctx = fixture();
  var id = randomUUID();
  assert.throws(() => recordMessage(ctx.userId, ctx.conversationId, { id, role: 'user', content: '不会单独写消息' }, { traceId: {} }), /traceId/);
  assert.equal(ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id), undefined);
  assert.equal(listEvents(ctx.userId, ctx.conversationId).events.length, 0);
});

async function recordedTrace(ctx) {
  var traceId = randomUUID();
  recordMessage(ctx.userId, ctx.conversationId, { role: 'user', content: '1 + 1?' }, { traceId });
  var decisions = [
    { content: '', toolCalls: [{ id: 'same-provider-id', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1 + 1"}' } }], finishReason: 'tool_calls', usage: {} },
    { content: '2', toolCalls: [], finishReason: 'stop', usage: {} },
  ];
  var executions = 0;
  var result = await runAgent({
    traceId, messages: [{ role: 'user', content: '1 + 1?' }],
    provider: { name: 'recording-provider', complete: async () => decisions.shift(), async *chat() { yield { type: 'text', text: '答案是 2' }; yield { type: 'done', finishReason: 'stop' }; } },
    tools: {
      getToolDefinitions: () => [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object' } } }],
      executeTool: async () => { executions++; return { result: 2 }; },
      renderToolResult: (name, args, value) => '结果：' + value.result,
    },
    onEvent: event => appendEvent(ctx.userId, ctx.conversationId, event.type, event.payload, { traceId }),
  });
  recordMessage(ctx.userId, ctx.conversationId, { role: 'assistant', content: result.content }, { traceId });
  return { traceId, executions };
}

test('Trace replay re-executes recorded decisions and results without network, writes, or real tools', async function () {
  var ctx = fixture();
  var { traceId, executions } = await recordedTrace(ctx);
  var before = listEvents(ctx.userId, ctx.conversationId);
  var previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('回放不得访问网络'); };
  try {
    var response = await app.inject({ method: 'POST', url: url(ctx, '/traces/' + traceId + '/replay'), headers: ctx.headers, payload: {} });
    assert.equal(response.statusCode, 200);
    var replay = response.json();
    assert.equal(replay.mode, 'rerun');
    assert.equal(replay.consistent, true, JSON.stringify(replay.checks));
    assert.equal(replay.behavior.answers[0], '答案是 2');
    assert.equal(replay.behavior.tools[0].arguments.expression, '1 + 1');
    assert.equal(executions, 1);
    assert.deepEqual(listEvents(ctx.userId, ctx.conversationId), before);
    var different = await replayTrace(ctx.userId, ctx.conversationId, traceId, { runner: async () => ({ tools: [], answers: ['错误'], termination: 'done' }) });
    assert.equal(different.consistent, false);
    assert.equal(different.checks.behaviorMatches, false);
    assert.equal(different.fingerprint, replay.fingerprint);
  } finally { globalThis.fetch = previousFetch; }
});

test('legacy/incomplete traces honestly report unavailable deterministic re-execution', async function () {
  var ctx = fixture();
  appendEvent(ctx.userId, ctx.conversationId, 'request', { message: '旧请求' }, { traceId: 'old' });
  appendEvent(ctx.userId, ctx.conversationId, 'done', { rounds: 0 }, { traceId: 'old' });
  var result = await replayTrace(ctx.userId, ctx.conversationId, 'old');
  assert.equal(result.mode, 'recorded');
  assert.equal(result.consistent, false);
  assert.equal(result.checks.reexecutionAvailable, false);
});

test('stream-only providers and custom retry limits are reproduced from recorded configuration', async function () {
  var ctx = fixture();
  var traceId = randomUUID();
  var turn = 0;
  var result = await runAgent({
    traceId, messages: [{ role: 'user', content: '允许一次失败' }], maxToolRounds: 2, maxConsecutiveFailures: 1,
    provider: { name: 'stream-only', async *chat() {
      if (turn++ === 0) yield { type: 'tool_call', call: { id: 'failed', type: 'function', function: { name: 'broken', arguments: '{}' } } };
      else yield { type: 'text', text: '工具不可用，停止调用' };
      yield { type: 'done', finishReason: 'stop' };
    } },
    tools: { getToolDefinitions: () => [{ type: 'function', function: { name: 'broken' } }],
      executeTool: async () => ({ error: 'offline failure' }), renderToolResult: (name, args, value) => JSON.stringify(value) },
    onEvent: event => appendEvent(ctx.userId, ctx.conversationId, event.type, event.payload, { traceId }),
  });
  recordMessage(ctx.userId, ctx.conversationId, { role: 'assistant', content: result.content }, { traceId });
  var replay = await replayTrace(ctx.userId, ctx.conversationId, traceId);
  assert.equal(replay.mode, 'rerun');
  assert.equal(replay.consistent, true, JSON.stringify(replay.checks));
  assert.equal(replay.behavior.answers[0], '工具不可用，停止调用');
});

test('loaded and historical assistant messages retain event-derived cards across forks without future tools', async function () {
  var ctx = fixture();
  var { traceId } = await recordedTrace(ctx);
  var loaded = await app.inject({ method: 'GET', url: url(ctx, '/messages'), headers: ctx.headers });
  var assistant = loaded.json().messages.find(item => item.role === 'assistant');
  assert.equal(assistant.tools.length, 1);
  assert.equal(assistant.tools[0].name, 'calculator');
  assert.equal(assistant.tools[0].done, true);
  assert.deepEqual(assistant.tools[0].result, { result: 2 });
  assert.equal(assistant.tools[0].rendered, '结果：2');
  appendEvent(ctx.userId, ctx.conversationId, 'tool_result', { id: 'future', tool: 'web_search', result: { private: 'future' }, status: 'done' }, { traceId });
  var historical = await app.inject({ method: 'GET', url: url(ctx, '/replay?upTo=' + assistant.seq), headers: ctx.headers });
  assert.deepEqual(historical.json().messages.at(-1).tools, assistant.tools);
  var fork = forkConversation(ctx.userId, ctx.conversationId, assistant.seq);
  assert.equal(fork.event.payload.snapshot.messages.at(-1).tools[0].name, 'calculator');
  recordMessage(ctx.userId, fork.conversation.id, { role: 'user', content: '分叉后继续' });
  var branch = replayConversation(ctx.userId, fork.conversation.id);
  assert.deepEqual(branch.messages[1].tools.map(tool => tool.name), ['calculator']);
  assert.equal(branch.messages[1].tools[0].message_id, fork.idMap.messages[assistant.id]);
  assert.deepEqual(branch.messages[1].tools[0].result, { result: 2 });
  assert.equal(branch.messages[1].trace_id, null);
  var reverted = rollbackConversation(ctx.userId, ctx.conversationId, assistant.seq);
  assert.deepEqual(reverted.state.messages.at(-1).tools, assistant.tools);
});

test('legacy tool cards attach by message id using immutable migrated events', async function () {
  var ctx = fixture();
  var messageId = randomUUID(), toolId = randomUUID();
  ctx.db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(messageId, ctx.conversationId, 'assistant', '旧工具回答');
  ctx.db.prepare('INSERT INTO tool_calls (id, message_id, tool_name, arguments, result, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(toolId, messageId, 'calculator', '{"expression":"3+4"}', '{"result":7}', 'done');
  var state = replayConversation(ctx.userId, ctx.conversationId);
  assert.equal(state.messages[0].trace_id, null);
  assert.deepEqual(state.messages[0].tools[0].result, { result: 7 });
  assert.equal(state.messages[0].tools[0].name, 'calculator');
  ctx.db.prepare('UPDATE tool_calls SET result = ? WHERE id = ?').run('{"result":999}', toolId);
  var response = await app.inject({ method: 'GET', url: url(ctx, '/messages'), headers: ctx.headers });
  assert.deepEqual(response.json().messages[0].tools[0].result, { result: 7 });
  assert.deepEqual(replayConversation(ctx.userId, ctx.conversationId, { upTo: state.messages[0].seq }).messages[0].tools, []);
  var branch = forkConversation(ctx.userId, ctx.conversationId, state.headSeq);
  assert.deepEqual(replayConversation(ctx.userId, branch.conversation.id).messages[0].tools[0].result, { result: 7 });
});

test('annotation cards follow the latest visible reply and remap reply links in fork snapshots', function () {
  var ctx = fixture();
  var root = message(ctx, '主线正文');
  var ann = annotation(ctx, root);
  var traceId = randomUUID();
  appendEvent(ctx.userId, ctx.conversationId, 'tool_result', { id: 'ann-tool', tool: 'calculator', result: { result: 5 }, status: 'done' }, { traceId });
  var first = recordMessage(ctx.userId, ctx.conversationId, { role: 'assistant', content: '第一版回答', kind: 'annotation', annotation_id: ann.id }, { traceId });
  var historical = replayConversation(ctx.userId, ctx.conversationId, { upTo: first.seq }).annotations[0];
  assert.equal(historical.answer, '第一版回答');
  assert.equal(historical.reply_message_id, first.id);
  assert.equal(historical.trace_id, traceId);
  assert.equal(historical.tools[0].name, 'calculator');
  assert.deepEqual(replayConversation(ctx.userId, ctx.conversationId, { upTo: ann.seq }).annotations[0].tools, []);
  var laterTrace = randomUUID();
  var second = recordMessage(ctx.userId, ctx.conversationId, { role: 'assistant', content: '第二版回答不用工具', kind: 'annotation', annotation_id: ann.id }, { traceId: laterTrace });
  var latest = replayConversation(ctx.userId, ctx.conversationId).annotations[0];
  assert.equal(latest.reply_message_id, second.id);
  assert.equal(latest.trace_id, laterTrace);
  assert.equal(latest.answer, '第二版回答不用工具');
  assert.deepEqual(latest.tools, []);
  var branch = forkConversation(ctx.userId, ctx.conversationId, first.seq);
  var branchState = replayConversation(ctx.userId, branch.conversation.id);
  assert.equal(branchState.annotations[0].reply_message_id, branch.idMap.messages[first.id]);
  assert.equal(branchState.annotations[0].trace_id, null);
  assert.equal(branchState.annotations[0].tools[0].name, 'calculator');
  assert.equal(branchState.annotations[0].tools[0].message_id, branch.idMap.messages[first.id]);
  assert.deepEqual(rollbackConversation(ctx.userId, ctx.conversationId, first.seq).state.annotations[0], historical);
});

test('same provider tool id in different traces keeps separate tool projections', async function () {
  var ctx = fixture();
  await recordedTrace(ctx);
  await recordedTrace(ctx);
  var state = replayConversation(ctx.userId, ctx.conversationId);
  assert.equal(state.toolCalls.length, 2);
  assert.notEqual(state.toolCalls[0].id, state.toolCalls[1].id);
  assert.equal(state.traces.length, 2);
});
