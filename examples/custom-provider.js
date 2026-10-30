import { ThreadThink } from 'threadthink';

// An adapter emits normalized events; ThreadThink owns tool execution and retries.
const localProvider = {
  supports: name => name === 'local-demo',
  async *chat(messages, { signal }) {
    signal.throwIfAborted();
    yield { type: 'text', text: '本地 provider 收到：' };
    yield { type: 'text', text: messages.at(-1).content };
    yield { type: 'done', finishReason: 'stop' };
  },
};
const app = new ThreadThink({ provider: 'local-demo', providers: [localProvider] });
try { console.log((await app.chat('无需凭据即可扩展')).content); }
finally { await app.dispose(); }
