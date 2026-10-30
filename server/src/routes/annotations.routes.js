/* ============================================================
   ThreadThink Server — Annotation Routes
   ============================================================ */

import { createAnnotation, listAnnotations, updateAnnotation, getAnnotation, buildAnnotationContext } from '../services/annotation.service.js';
import { replyWithChatStream, isConversationBusy } from '../services/chat-stream.js';

function sendError(reply, error) {
  return reply.code(/不存在/.test(error.message) ? 404 : 400).send({ error: error.message });
}

export function annotationRoutes(fastify, opts, done) {
  fastify.post('/api/annotations', async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: '未登录' });
    try {
      return reply.code(201).send({ annotation: createAnnotation(request.user.id, request.body || {}) });
    } catch (error) { return sendError(reply, error); }
  });

  fastify.get('/api/annotations', async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: '未登录' });
    var conversationId = request.query.conversationId;
    if (typeof conversationId !== 'string' || !conversationId.trim()) return reply.code(400).send({ error: '缺少 conversationId' });
    try {
      return { annotations: listAnnotations(request.user.id, conversationId) };
    } catch (error) { return sendError(reply, error); }
  });

  fastify.put('/api/annotations/:id', async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: '未登录' });
    try {
      var owned = getAnnotation(request.user.id, request.params.id);
      if (isConversationBusy(request.user.id, owned.conversationId)) return reply.code(409).send({ error: '请等待当前回答完成后编辑批注' });
      return { annotation: updateAnnotation(request.user.id, request.params.id, request.body || {}) };
    } catch (error) { return sendError(reply, error); }
  });

  fastify.post('/api/annotations/:id/reply', async function (request, reply) {
    if (!request.user) return reply.code(401).send({ error: '未登录' });
    var context;
    try { context = await buildAnnotationContext(request.user.id, request.params.id); }
    catch (error) { return sendError(reply, error); }
    await replyWithChatStream(reply, {
      userId: request.user.id, conversationId: context.conversationId,
      kind: 'annotation', annotationId: context.annotation.id,
      message: '【追问】' + context.annotation.question,
      contextMessages: context.messages, contextSections: context.sections,
    });
  });
  done();
}
