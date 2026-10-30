import { ThreadThink } from 'threadthink';
import { mockProvider, toolCall } from 'threadthink/testkit';

const app = new ThreadThink({
  provider: mockProvider({ responses: [{ toolCalls: [toolCall('greet', { name: '开发者' })] }, '你好，开发者！'] }),
  tools: [{
    name: 'greet', description: '按姓名问候', parameters: { name: { type: 'string' } },
    output: {
      schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] },
      render: (args, value) => value.greeting,
      presentationMeta: (args, value) => ({ title: '问候', text: value.greeting }),
    },
    execute: async ({ name }, { signal }) => { signal.throwIfAborted(); return { greeting: '你好，' + name + '！' }; },
  }],
});
try {
  const reply = await app.chat('向开发者问好');
  console.log(reply.content);
  console.log(reply.toolCalls[0].result);
} finally { await app.dispose(); }
