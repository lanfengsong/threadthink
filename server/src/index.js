/* ============================================================
   ThreadThink Server — Fastify Entry Point
   ============================================================ */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { verifyToken } from './services/auth.service.js';
import { authRoutes } from './routes/auth.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { conversationsRoutes } from './routes/conversations.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';

var fastify = Fastify({ logger: true });

// CORS
await fastify.register(cors, {
  origin: [config.corsOrigin, 'http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// Auth decorator — adds user to request if token is valid
fastify.decorateRequest('user', null);

fastify.addHook('onRequest', async function (request) {
  var publicPaths = ['/api/auth/register', '/api/auth/login', '/api/health'];
  var path = request.url.split('?')[0];
  if (publicPaths.indexOf(path) !== -1) return;

  var header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return;

  var token = header.slice(7);
  try {
    var payload = verifyToken(token);
    request.user = { id: payload.sub, email: payload.email };
  } catch (e) {
    // Token invalid, user stays null — routes will handle 401
  }
});

// Health check
fastify.get('/api/health', async function () {
  return { status: 'ok', time: new Date().toISOString() };
});

// Protected route helper
function requireAuth(request, reply) {
  if (!request.user) {
    reply.code(401).send({ error: '未登录，请先登录' });
    return false;
  }
  return true;
}

// Routes
fastify.register(authRoutes, { requireAuth });
fastify.register(chatRoutes, { requireAuth });
fastify.register(conversationsRoutes, { requireAuth });
fastify.register(settingsRoutes, { requireAuth });

// Init DB
getDb();

// Start
try {
  await fastify.listen({ port: config.port, host: config.host });
  console.log('ThreadThink Server running on http://' + config.host + ':' + config.port);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
