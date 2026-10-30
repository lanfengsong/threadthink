import { createMcpServer, MCP_PROTOCOL_VERSIONS } from '../services/tools/mcp.js';
import { defaultToolRegistry } from '../services/tools/index.js';

/** Stateless Streamable HTTP: POST returns JSON, notifications receive 202;
 * GET/DELETE return 405 (no persistent SSE stream or session to terminate).
 * Mount with {prefix:'/api/mcp', authenticate} or the app's requireAuth helper.
 */
export async function mcpRoutes(fastify, options) {
  var opts = options || {};
  var server = createMcpServer({ registry: opts.registry || defaultToolRegistry });
  var authenticate = opts.authenticate || opts.requireAuth;
  var allowedOrigins = opts.allowedOrigins || [];

  async function guard(request, reply) {
    if (authenticate) {
      var accepted = await authenticate(request, reply);
      if (reply.sent) return reply;
      if (accepted === false) return reply.code(401).send({ error: 'Authentication required' });
    } else if (!request.user) return reply.code(401).send({ error: 'Authentication required' });
    // Explicit Origin allowlist for browser clients; native clients omit Origin.
    if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
  }

  // MCP parse errors must use the JSON-RPC envelope rather than Fastify's JSON.
  fastify.setErrorHandler(function (error, request, reply) {
    if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    reply.code(error.statusCode || 500).send({ jsonrpc: '2.0', id: null, error: {
      code: error.statusCode === 413 ? -32600 : -32603,
      message: error.statusCode === 413 ? 'Request exceeds size limit' : 'Request failed',
    } });
  });

  fastify.route({
    method: 'POST', url: '/', bodyLimit: 65536, onRequest: guard,
    handler: async function (request, reply) {
      var contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') return reply.code(415).send({ error: 'Content-Type must be application/json' });
      var version = request.headers['mcp-protocol-version'];
      if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
        return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported protocol version' } });
      }
      var accept = request.headers.accept;
      if (accept && !accept.includes('application/json') && !accept.includes('*/*')) {
        return reply.code(406).send({ error: 'Accept must include application/json' });
      }
      var controller = new AbortController();
      function cancel() { controller.abort(new Error('MCP client disconnected')); }
      function onClose() { if (!reply.raw.writableEnded) cancel(); }
      request.raw.on('aborted', cancel);
      reply.raw.on('close', onClose);
      try {
        var response = await server.handle(request.body, { userId: request.user && request.user.id, signal: controller.signal });
        if (controller.signal.aborted || reply.raw.destroyed) return;
        if (response === null) return reply.code(202).send();
        if (response.error && [-32700, -32600, -32602].includes(response.error.code)) reply.code(400);
        return reply.type('application/json').send(response);
      } finally {
        request.raw.removeListener('aborted', cancel);
        reply.raw.removeListener('close', onClose);
      }
    },
  });
  fastify.route({
    method: ['GET', 'DELETE'], url: '/', onRequest: guard,
    handler: async function (request, reply) { return reply.header('Allow', 'POST').code(405).send(); },
  });
  fastify.addHook('onClose', async function () { server.close(); });
}

export default mcpRoutes;
