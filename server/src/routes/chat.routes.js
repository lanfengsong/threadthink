/* ============================================================
   ThreadThink Server — Chat Route (SSE streaming)
   ============================================================ */

import { streamChat } from '../services/ai.service.js';
import { getDb } from '../db/connection.js';

export function chatRoutes(fastify, opts, done) {
  fastify.post('/api/chat/stream', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }

    var { conversationId, message } = request.body || {};
    if (typeof conversationId !== 'string' || !conversationId.trim() || typeof message !== 'string' || !message.trim()) {
      reply.code(400).send({ error: '缺少 conversationId 或 message' });
      return;
    }

    var conversation = getDb().prepare(
      'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
    ).get(conversationId, request.user.id);
    if (!conversation) {
      reply.code(404).send({ error: '对话不存在' });
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    var terminalSent = false;
    function writeEvent(event, data) {
      if (terminalSent) return;
      reply.raw.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      if (event === 'done' || event === 'error') terminalSent = true;
    }
    function endStream() {
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    try {
      await streamChat(
        { userId: request.user.id, conversationId: conversationId, message: message },
        function (token) { if (!terminalSent) writeEvent('token', { content: token }); },
        function (ts) { if (!terminalSent) writeEvent('tool_start', ts); },
        function (te) { if (!terminalSent) writeEvent('tool_end', te); },
        function (done) { writeEvent('done', done); endStream(); },
        function (error) { writeEvent('error', error); endStream(); }
      );
    } catch (e) {
      writeEvent('error', { message: e.message });
      endStream();
    }
  });

  done();
}
