/* ============================================================
   ThreadThink Server — Settings Routes
   ============================================================ */

import { getUserSettings, updateUserSettings } from '../services/auth.service.js';

export function settingsRoutes(fastify, opts, done) {
  fastify.get('/api/settings', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      reply.send(getUserSettings(request.user.id));
    } catch (e) {
      reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });

  fastify.put('/api/settings', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      reply.send(updateUserSettings(request.user.id, request.body || {}));
    } catch (e) {
      reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });

  done();
}
