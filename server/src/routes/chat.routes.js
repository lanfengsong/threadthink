/* ============================================================
   ThreadThink Server — Chat Route (SSE streaming)
   ============================================================ */

import { getDb } from '../db/connection.js';
import { replyWithChatStream } from '../services/chat-stream.js';

export function chatRoutes(fastify, opts, done) {
  fastify.post('/api/chat/stream', async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: '未登录' });
    var { conversationId, message } = request.body || {};
    if (typeof conversationId !== 'string' || !conversationId.trim() || typeof message !== 'string' || !message.trim() || message.length > 100000) {
      return reply.code(400).send({ error: '缺少 conversationId 或 message，或消息过长' });
    }
    var conversation = getDb().prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(conversationId, request.user.id);
    if (!conversation) return reply.code(404).send({ error: '对话不存在' });
    await replyWithChatStream(reply, { userId: request.user.id, conversationId: conversationId, message: message });
  });
  done();
}
