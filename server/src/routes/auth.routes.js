/* ============================================================
   ThreadThink Server — Auth Routes
   ============================================================ */

import { register, login, refreshToken } from '../services/auth.service.js';

export function authRoutes(fastify, opts, done) {
  fastify.post('/api/auth/register', async function (request, reply) {
    try {
      var body = request.body || {};
      var result = register(body.email, body.password);
      reply.send(result);
    } catch (e) {
      reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });

  fastify.post('/api/auth/login', async function (request, reply) {
    try {
      var body = request.body || {};
      var result = login(body.email, body.password);
      reply.send(result);
    } catch (e) {
      reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });

  fastify.post('/api/auth/refresh', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      var token = refreshToken(request.user.id);
      reply.send({ token: token });
    } catch (e) {
      reply.code(e.statusCode || 500).send({ error: e.message });
    }
  });

  done();
}
