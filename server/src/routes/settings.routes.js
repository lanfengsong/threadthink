/* ============================================================
   ThreadThink Server — Settings Routes
   ============================================================ */

import { getUserSettings, updateUserSettings } from '../services/auth.service.js';

export function settingsRoutes(fastify, opts, done) {
  fastify.get('/api/settings', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    reply.send(getUserSettings(request.user.id));
  });

  fastify.put('/api/settings', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    reply.send(updateUserSettings(request.user.id, request.body || {}));
  });

  done();
}
