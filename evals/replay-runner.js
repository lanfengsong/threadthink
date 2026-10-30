import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../core/orchestrator.js';
import { createMockProvider } from '../core/providers.js';

/** Run in an isolated process: the server's DB/config modules are process singletons. */
export async function createReplayEvalRunner() {
  const directory = mkdtempSync(join(tmpdir(), 'threadthink-replay-eval-'));
  const env = { DB_PATH: process.env.DB_PATH, JWT_SECRET: process.env.JWT_SECRET, ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET };
  process.env.DB_PATH = join(directory, 'eval.db');
  process.env.JWT_SECRET = 'local-replay-eval-secret';
  process.env.ENCRYPTION_SECRET = 'local-replay-eval-encryption-key';
  let app, closeDb;
  async function dispose() {
    try { await app?.close(); }
    finally {
      closeDb?.();
      rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
  try {
    const { buildApp } = await import('../server/src/app.js');
    const connection = await import('../server/src/db/connection.js');
    closeDb = connection.closeDb;
    const { appendEvent, recordMessage } = await import('../server/src/services/events.service.js');
    app = await buildApp({ logger: false });
    async function request(method, url, token, payload) {
      return app.inject({ method, url, ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}), ...(payload === undefined ? {} : { payload }) });
    }
    async function register(email) {
      const response = await request('POST', '/api/auth/register', null, { email, password: 'eval-password-123' });
      if (response.statusCode !== 200) throw new Error('Replay fixture registration failed: ' + response.statusCode);
      return response.json();
    }
    async function conversation(token) {
      const response = await request('POST', '/api/conversations', token, { title: 'Replay evaluation fixture' });
      if (response.statusCode !== 201) throw new Error('Replay fixture conversation failed: ' + response.statusCode);
      return response.json().conversation.id;
    }
    const alice = await register('eval-alice@example.test');
    const bob = await register('eval-bob@example.test');
    const aliceConversation = await conversation(alice.token);
    const bobConversation = await conversation(bob.token);
    const secret = 'REPLAY_PRIVATE_CANARY_918b';
    const traceId = 'eval-owner-trace';
    recordMessage(alice.user.id, aliceConversation, { role: 'user', content: secret }, { traceId });
    const provider = createMockProvider({ responses: [{ content: secret }] });
    await runAgent({ provider, messages: [{ role: 'user', content: secret }], traceId,
      onEvent: event => appendEvent(alice.user.id, aliceConversation, event.type, event.payload, { traceId }) });
    await provider.dispose?.();
    recordMessage(alice.user.id, aliceConversation, { role: 'assistant', content: secret }, { traceId });
    const base = '/api/conversations/' + aliceConversation;
    const bobBase = '/api/conversations/' + bobConversation;
    return { dispose, async runTask() {
      const owner = await request('GET', base + '/replay', alice.token);
      const ownerTrace = await request('POST', base + '/traces/' + traceId + '/replay', alice.token, {});
      const count = () => connection.getDb().prepare('SELECT count(*) AS count FROM events').get().count;
      const eventCountBefore = count();
      const attempts = [
        ['anonymous replay', 'GET', base + '/replay', null, 401],
        ['foreign conversation replay', 'GET', base + '/replay', bob.token, 404],
        ['foreign event log', 'GET', base + '/events', bob.token, 404],
        ['foreign trace details', 'GET', base + '/traces/' + traceId, bob.token, 404],
        ['foreign trace rerun', 'POST', base + '/traces/' + traceId + '/replay', bob.token, 404],
        ['trace moved to own conversation', 'GET', bobBase + '/traces/' + traceId, bob.token, 404],
        ['trace rerun in own conversation', 'POST', bobBase + '/traces/' + traceId + '/replay', bob.token, 404],
        ['foreign fork', 'POST', base + '/fork', bob.token, 404, { seq: 0 }],
        ['foreign rollback', 'POST', base + '/rollback', bob.token, 404, { seq: 0 }],
      ];
      const probes = [];
      for (const [name, method, url, token, expected, payload] of attempts) {
        const response = await request(method, url, token, payload);
        probes.push({ name, status: response.statusCode, expected, leaked: response.body.includes(secret) });
      }
      const evidence = { kind: 'real-fastify-inject-temporary-sqlite', ownerStatus: owner.statusCode,
        ownerContainsPrivateMessage: owner.body.includes(secret), ownerTraceStatus: ownerTrace.statusCode,
        ownerTraceConsistent: ownerTrace.json().consistent === true, probes, eventCountBefore, eventCountAfter: count() };
      return { ...evidence, evidence, output: 'Replay authorization probes completed', toolCalls: [] };
    } };
  } catch (error) { await dispose(); throw error; }
}
