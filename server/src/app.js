/* ============================================================
   ThreadThink Server — Application Factory
   ============================================================ */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { verifyToken } from './services/auth.service.js';
import { authRoutes } from './routes/auth.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { conversationsRoutes } from './routes/conversations.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { documentsRoutes } from './routes/documents.routes.js';
import { annotationRoutes } from './routes/annotations.routes.js';

export async function buildApp(options) {
  var opts = options || {};
  var fastify = Fastify({ logger: opts.logger === undefined ? false : opts.logger });

  await fastify.register(cors, {
    origin: [config.corsOrigin, 'http://localhost:5173', 'http://localhost:4173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  fastify.decorateRequest('user', null);
  fastify.addHook('onRequest', async function (request) {
    var publicPaths = ['/api/auth/register', '/api/auth/login', '/api/health'];
    var path = request.url.split('?')[0];
    if (publicPaths.indexOf(path) !== -1) return;

    var header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return;

    try {
      var payload = verifyToken(header.slice(7));
      request.user = { id: payload.sub, email: payload.email };
    } catch (e) {
      // Routes consistently return 401 when authentication fails.
    }
  });

  fastify.get('/api/health', async function () {
    return { status: 'ok', time: new Date().toISOString() };
  });

  function requireAuth(request, reply) {
    if (!request.user) {
      reply.code(401).send({ error: '未登录，请先登录' });
      return false;
    }
    return true;
  }

  fastify.register(authRoutes, { requireAuth });
  fastify.register(chatRoutes, { requireAuth });
  fastify.register(conversationsRoutes, { requireAuth });
  fastify.register(settingsRoutes, { requireAuth });
  fastify.register(documentsRoutes, { requireAuth });
  fastify.register(annotationRoutes, { requireAuth });

  getDb();
  await fastify.ready();
  return fastify;
}

export async function startServer() {
  var fastify = await buildApp({ logger: true });
  try {
    await fastify.listen({ port: config.port, host: config.host });
    console.log('ThreadThink Server running on http://' + config.host + ':' + config.port);
    return fastify;
  } catch (err) {
    fastify.log.error(err);
    throw err;
  }
}
