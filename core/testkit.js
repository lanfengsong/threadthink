import { createMockProvider } from './providers.js';
import { createToolRegistry } from './tools.js';

export const mockProvider = createMockProvider;

export function toolCall(name, args = {}, id = 'call_1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export function mockTool(options = {}) {
  var calls = [];
  var disposed = false;
  return {
    name: options.name || 'mock_tool', description: options.description || 'Deterministic test tool',
    parameters: options.parameters || { type: 'object', additionalProperties: true },
    output: options.output,
    calls,
    get disposed() { return disposed; },
    async execute(args, context) {
      calls.push({ args: structuredClone(args), context });
      return options.execute ? await options.execute(args, context) : structuredClone(options.result ?? { ok: true });
    },
    async dispose() { disposed = true; await options.dispose?.(); },
  };
}

/** Exercise the same schema/runtime/render contract as production without a provider. */
export async function testTool(tool, args, context = {}) {
  var registry = createToolRegistry();
  var name = tool.name || tool.definition?.function?.name;
  registry.registerTool(tool);
  try {
    var value = await registry.executeTool(name, args, context);
    return { value, rendered: registry.renderToolResult(name, args, value), presentation: registry.getToolPresentationMeta(name, args, value) };
  } finally { await registry.dispose(); }
}
