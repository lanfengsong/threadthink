/* ============================================================
   ThreadThink Server — Chat Route (SSE streaming)
   ============================================================ */

import { streamChat } from '../services/ai.service.js';

export function chatRoutes(fastify, opts, done) {
  fastify.post('/api/chat/stream', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }

    var { conversationId, message } = request.body || {};
    if (!conversationId || !message) {
      reply.code(400).send({ error: '缺少 conversationId 或 message' });
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    function writeEvent(event, data) {
      reply.raw.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    }

    try {
      await streamChat(
        { userId: request.user.id, conversationId: conversationId, message: message },
        function (token) { writeEvent('token', { content: token }); },
        function (ts) { writeEvent('tool_start', ts); },
        function (te) { writeEvent('tool_end', te); },
        function (done) { writeEvent('done', done); reply.raw.end(); },
        function (error) { writeEvent('error', error); reply.raw.end(); }
      );
    } catch (e) {
      writeEvent('error', { message: e.message });
      reply.raw.end();
    }
  });

  done();
}
