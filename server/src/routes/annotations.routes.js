/* ============================================================
   ThreadThink Server — Annotation Routes
   ============================================================ */

import { createAnnotation, listAnnotations } from '../services/annotation.service.js';

export function annotationRoutes(fastify, opts, done) {
  fastify.post('/api/annotations', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      var annotation = createAnnotation(request.user.id, request.body || {});
      reply.code(201).send({ annotation: annotation });
    } catch (e) {
      var notFound = e.message === '消息不存在';
      reply.code(notFound ? 404 : 400).send({ error: e.message });
    }
  });

  fastify.get('/api/annotations', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var conversationId = request.query.conversationId;
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      reply.code(400).send({ error: '缺少 conversationId' });
      return;
    }
    try {
      reply.send({ annotations: listAnnotations(request.user.id, conversationId) });
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  done();
}