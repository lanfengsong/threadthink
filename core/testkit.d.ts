import type { MockProvider, MockProviderOptions, Tool, ToolContext, ToolOutput, ToolCall, JsonValue, JsonSchema } from './index.js';
export function mockProvider(options?: MockProviderOptions): MockProvider;
export function toolCall(name: string, args?: Record<string, unknown>, id?: string): ToolCall;
export function mockTool<A = Record<string, unknown>, V = JsonValue>(options?: { name?: string; description?: string; parameters?: JsonSchema; output?: ToolOutput<A, V>; result?: V; execute?(args: A, context: ToolContext): V | Promise<V>; dispose?(): void | Promise<void> }): Tool<A, V> & { readonly disposed: boolean; calls: Array<{ args: A; context: ToolContext }> };
export function testTool<A, V>(tool: Tool<A, V>, args: A, context?: ToolContext): Promise<{ value: unknown; rendered: string; presentation: JsonValue }>;
