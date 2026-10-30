import { ThreadThink, createToolRegistry, createProviderRegistry, assembleContext, runAgent, type ProviderAdapter, type Tool, type ChatResult } from 'threadthink';
import { mockProvider, mockTool, testTool, toolCall } from 'threadthink/testkit';

const tool: Tool<{ query: string }, { answer: string }> = {
  name: 'lookup', parameters: { query: { type: 'string' } },
  output: { schema: { type: 'object' }, render: (_args, value) => value.answer },
  async execute(args, context) { context.signal?.throwIfAborted(); return { answer: args.query }; },
};
const provider: ProviderAdapter = {
  supports: name => name === 'custom',
  async *chat(messages) { yield { type: 'text', text: messages[0].content }; },
};
const registry = createToolRegistry();
const unregister = registry.registerTool(tool);
const providers = createProviderRegistry();
providers.register({ ...provider, supports: name => name === 'custom' });
const app = new ThreadThink({ provider: mockProvider({ responses: [{ toolCalls: [toolCall('lookup', { query: 'test' })] }, 'done'] }), tools: [tool] });
const reply: ChatResult = await app.chat('test', { onToken(text) { text.toUpperCase(); } });
const nullableUsage: number | null = reply.usage.totalTokens;
await app.annotate({ selectedText: 'test', question: 'why?', source: reply.content });
await testTool(mockTool({ result: { ok: true } }), {});
const context = await assembleContext({ persona: 'assistant' });
await runAgent({ messages: context.messages, provider, tools: registry });
await unregister();
await app.dispose();
void nullableUsage;
// @ts-expect-error message must be text
app.chat(123);
// @ts-expect-error tool implementations are mandatory
registry.registerTool({ name: 'invalid' });
