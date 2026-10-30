/* Conversations and authenticated, append-only history APIs. */
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { listEvents, replayConversation, forkConversation, rollbackConversation,
  deleteConversation, listTraces, getTrace, replayTrace } from '../services/events.service.js';
import { isConversationBusy } from '../services/chat-stream.js';

export function conversationsRoutes(fastify, opts, done) {
  function route(method, path, handler) {
    fastify[method](path, async function (request, reply) {
      if (!request.user) return reply.code(401).send({ error: '未登录' });
      try { return await handler(request, reply); }
      catch (error) {
        if (!error.statusCode || error.statusCode >= 500) request.log.error(error);
        return reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : '历史记录操作失败' });
      }
    });
  }
  function seq(value, optional = false) {
    if (value === undefined && optional) return undefined;
    if (!['number', 'string'].includes(typeof value) || value === '' || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
      var error = new Error('seq 必须是非负整数'); error.statusCode = 400; throw error;
    }
    return Number(value);
  }
  function checkIdle(request) {
    if (isConversationBusy(request.user.id, request.params.id)) {
      var error = new Error('该对话正在生成回答，请稍后重试'); error.statusCode = 409; throw error;
    }
  }

  route('get', '/api/conversations', function (request) {
    return { conversations: getDb().prepare(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
    ).all(request.user.id) };
  });

  route('post', '/api/conversations', function (request, reply) {
    var db = getDb();
    var id = uuid();
    var title = request.body?.title || '新对话';
    if (typeof title !== 'string' || title.length > 500) return reply.code(400).send({ error: '无效的对话标题' });
    db.prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)').run(id, request.user.id, title);
    return reply.code(201).send({ conversation: db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?').get(id) });
  });

  route('get', '/api/conversations/:id/messages', function (request) {
    var state = replayConversation(request.user.id, request.params.id, { upTo: seq(request.query.upTo, true) });
    return { messages: state.messages.filter(function (message) { return message.kind === 'chat'; }) };
  });

  route('get', '/api/conversations/:id/events', function (request) {
    return listEvents(request.user.id, request.params.id, { after: seq(request.query.after, true), upTo: seq(request.query.upTo, true) });
  });

  route('get', '/api/conversations/:id/replay', function (request) {
    return replayConversation(request.user.id, request.params.id, { upTo: seq(request.query.upTo, true) });
  });

  route('post', '/api/conversations/:id/fork', function (request, reply) {
    return reply.code(201).send(forkConversation(request.user.id, request.params.id, seq(request.body?.seq), { title: request.body?.title }));
  });

  route('post', '/api/conversations/:id/rollback', function (request) {
    // Ownership is checked before the shared generation lock to avoid revealing another user's state.
    replayConversation(request.user.id, request.params.id, { upTo: 0 });
    checkIdle(request);
    return rollbackConversation(request.user.id, request.params.id, seq(request.body?.seq));
  });

  route('delete', '/api/conversations/:id', function (request) {
    replayConversation(request.user.id, request.params.id, { upTo: 0 });
    checkIdle(request);
    return deleteConversation(request.user.id, request.params.id);
  });

  route('get', '/api/conversations/:id/traces', function (request) {
    return listTraces(request.user.id, request.params.id);
  });

  route('get', '/api/conversations/:id/traces/:traceId', function (request) {
    return getTrace(request.user.id, request.params.id, request.params.traceId);
  });

  route('post', '/api/conversations/:id/traces/:traceId/replay', function (request) {
    return replayTrace(request.user.id, request.params.id, request.params.traceId, { expected: request.body?.expected });
  });
  done();
}
