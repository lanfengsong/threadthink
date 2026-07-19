/* ============================================================
   ThreadThink Server — Conversations Routes
   ============================================================ */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';

export function conversationsRoutes(fastify, opts, done) {
  var requireAuth = opts.requireAuth;

  fastify.get('/api/conversations', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var db = getDb();
    var rows = db.prepare(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(request.user.id);
    reply.send({ conversations: rows });
  });

  fastify.post('/api/conversations', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var db = getDb();
    var id = uuid();
    var title = (request.body && request.body.title) || '新对话';
    db.prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)').run(id, request.user.id, title);
    var row = db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?').get(id);
    reply.code(201).send({ conversation: row });
  });

  fastify.get('/api/conversations/:id/messages', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var db = getDb();
    var conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(request.params.id, request.user.id);
    if (!conv) { reply.code(404).send({ error: '对话不存在' }); return; }
    var messages = db.prepare(
      'SELECT id, role, content, annotations, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(request.params.id);
    reply.send({ messages: messages });
  });

  fastify.delete('/api/conversations/:id', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var db = getDb();
    var conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(request.params.id, request.user.id);
    if (!conv) { reply.code(404).send({ error: '对话不存在' }); return; }
    db.prepare('DELETE FROM conversations WHERE id = ?').run(request.params.id);
    reply.send({ success: true });
  });

  done();
}
