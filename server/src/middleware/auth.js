/* ============================================================
   ThreadThink Server — JWT Auth Middleware
   ============================================================ */

import { verifyToken } from '../services/auth.service.js';

export function authMiddleware(request, reply) {
  // Skip auth for register/login
  var publicPaths = ['/api/auth/register', '/api/auth/login', '/api/health'];
  var path = request.url.split('?')[0];
  if (publicPaths.indexOf(path) !== -1) return;

  var header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: '未登录，请先登录' });
    return;
  }

  var token = header.slice(7);
  try {
    var payload = verifyToken(token);
    request.user = { id: payload.sub, email: payload.email };
  } catch (e) {
    reply.code(401).send({ error: '登录已过期，请重新登录' });
  }
}
