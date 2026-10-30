export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string; is_error?: boolean; providerContent?: unknown[] }
export interface ProviderUsage { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; inputTokens?: number; outputTokens?: number }
export interface ProviderResponse { content: string; toolCalls?: ToolCall[]; finishReason?: string; usage?: ProviderUsage; providerContent?: unknown[] }
export type ProviderEvent = string | { type: 'text' | 'token'; text?: string; token?: string } | { type: 'tool_call'; call: ToolCall } | { type: 'done' | 'usage' | 'stop'; finishReason?: string; usage?: ProviderUsage } | { type: 'error'; message: string };
export interface ProviderRequest { tools?: ToolDefinition[]; signal?: AbortSignal; context?: ToolContext; response?: ProviderResponse }
export interface ProviderAdapter {
  name?: string;
  supports?(provider: string): boolean;
  chat(messages: Message[], options?: ProviderRequest): AsyncIterable<ProviderEvent>;
  complete?(messages: Message[], options?: ProviderRequest): Promise<ProviderResponse>;
  embed?(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
  dispose?(): void | Promise<void>;
}
export interface ProviderOptions { apiKey?: string; apiKeyEnv?: string; apiBase?: string; baseURL?: string; model?: string; maxTokens?: number; timeoutMs?: number; embeddingBase?: string; embeddingModel?: string; fetch?: typeof fetch }
export interface MockProviderOptions {
  responses?: Array<string | Partial<ProviderResponse> | Error | ((messages: Message[], options: ProviderRequest) => string | Partial<ProviderResponse> | Promise<string | Partial<ProviderResponse>>)>;
  reply?: string; chunkSize?: number;
}
export interface MockProvider extends ProviderAdapter { name: 'mock'; requests: Array<{ messages: Message[]; tools: ToolDefinition[] }>; complete(messages: Message[], options?: ProviderRequest): Promise<ProviderResponse>; embed(texts: string[]): Promise<number[][]> }
export interface ToolContext { signal?: AbortSignal; userId?: string; conversationId?: string; sessionId?: string; traceId?: string; kind?: string; annotationId?: string; timeoutMs?: number; [key: string]: unknown }
export interface ToolOutput<A = Record<string, unknown>, V = JsonValue> { schema?: JsonSchema; render?(args: A, value: V): string; presentationMeta?(args: A, value: V): JsonValue }
export interface Tool<A = Record<string, unknown>, V = JsonValue> {
  name: string; description?: string; parameters?: JsonSchema; inputSchema?: JsonSchema; input_schema?: JsonSchema;
  output?: ToolOutput<A, V>; timeoutMs?: number;
  execute(args: A, context: ToolContext): V | Promise<V>;
  dispose?(): void | Promise<void>;
}
export interface ToolDefinition { type: 'function'; function: { name: string; description?: string; parameters: JsonSchema } }
export interface LegacyTool { definition: ToolDefinition; execute(args: Record<string, unknown>, context: ToolContext): unknown; dispose?(): void | Promise<void> }
export interface McpToolDefinition { name: string; description: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }
export interface ToolLimits { timeoutMs?: number; maxInputBytes?: number; maxOutputBytes?: number; maxConcurrent?: number }
export interface ToolRuntime {
  getToolDefinitions(): ToolDefinition[];
  executeTool(name: string, args?: Record<string, unknown>, context?: ToolContext): Promise<unknown>;
  renderToolResult(name: string, args: Record<string, unknown>, value: unknown): string;
  getToolPresentationMeta?(name: string, args: Record<string, unknown>, value: unknown): JsonValue;
}
export interface ToolRegistry extends ToolRuntime {
  registerTool<A, V>(tool: Tool<A, V> | LegacyTool): () => Promise<boolean | void>;
  registerTool(name: string, definition: ToolDefinition, execute: LegacyTool['execute']): () => Promise<boolean | void>;
  unregisterTool(name: string): Promise<boolean>;
  dispose(): Promise<void>;
  hasTool(name: string): boolean;
  getMcpToolDefinitions(): McpToolDefinition[];
  getToolPresentationMeta(name: string, args: Record<string, unknown>, value: unknown): JsonValue;
}
export interface AgentEvent { type: string; payload: Record<string, unknown>; traceId: string; timestamp: string }
export interface SessionEvent { seq: number; type: string; payload: Record<string, unknown>; traceId: string | null; timestamp: string }
export interface Termination { reason: 'completed' | 'max_tool_rounds' | 'blocked' | 'aborted' | 'refusal' | 'max_tokens'; message?: string }
export interface Usage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reportedInputTokens: number; reportedOutputTokens: number }
export interface ToolAudit { id: string; tool_name: string; arguments: Record<string, unknown>; result: unknown; rendered: string; presentation: JsonValue; status: 'done' | 'error'; durationMs: number }
export interface ChatResult { content: string; toolCalls: ToolAudit[]; traceId: string; termination: Termination; usage: Usage; messages: Message[]; rounds: number }
export interface StepState { messages: Message[]; allowed: boolean }
export type PreStepHook = (state: StepState, context: ToolContext) => StepState | void | Promise<StepState | void>;
export interface Callbacks {
  onToken?(text: string): void | Promise<void>;
  onToolStart?(call: { tool_name: string; arguments: Record<string, unknown> }): void | Promise<void>;
  onToolEnd?(call: ToolAudit): void | Promise<void>;
  onEvent?(event: AgentEvent): void | Promise<void>;
}
export interface ContextInput { persona?: string; history?: unknown; rag?: unknown; source?: unknown; thread?: unknown; selectedText?: string; question?: string; [key: string]: unknown }
export interface ContextSection { id: string; label?: string; role?: Message['role']; maxTokens: number; trusted?: boolean; build(context: ContextInput): unknown | Promise<unknown> }
export interface ContextSectionResult { id: string; role: Message['role']; content: string; tokens: number; maxTokens: number; truncated: boolean }
export interface ChatOptions extends Callbacks { signal?: AbortSignal; context?: string | ContextInput; contextMessages?: Message[]; sections?: ContextSection[]; kind?: 'chat' | 'annotation'; annotationId?: string; upTo?: number; toolContext?: ToolContext }
export interface AgentOptions extends Callbacks { messages: Message[]; provider: ProviderAdapter; tools?: ToolRuntime; hooks?: PreStepHook[]; context?: ToolContext; signal?: AbortSignal; maxToolRounds?: number; maxConsecutiveFailures?: number; traceId?: string }
export interface PluginSpec { path: string; options?: Record<string, unknown> }
export interface PluginHandle { name: string; dispose(): Promise<void> }
export interface PluginContext { registerTool<A, V>(tool: Tool<A, V> | LegacyTool): () => Promise<boolean | void>; config: Record<string, unknown>; manifest?: { name: string; apiVersion: 1; main?: string } }
export interface ThreadThinkOptions {
  provider?: string | ProviderAdapter; providers?: Array<ProviderAdapter & { supports(provider: string): boolean }>;
  providerOptions?: ProviderOptions & MockProviderOptions; persona?: string;
  tools?: Array<Tool<any, any> | LegacyTool>; builtinTools?: boolean; toolSettings?: Record<string, boolean>; toolLimits?: ToolLimits;
  hooks?: PreStepHook[]; plugins?: Array<string | PluginSpec>; pluginDirectory?: string;
  maxToolRounds?: number; maxConsecutiveFailures?: number;
  rag?: { chunkSize?: number; overlap?: number; topK?: number };
  contextBudgets?: Record<string, number>; cwd?: string; configDir?: string; session?: SessionSnapshot;
}
export interface ConfigLoadOptions { cwd?: string; path?: string; profile?: string; env?: Record<string, string | undefined>; overrides?: ThreadThinkOptions }
export interface SessionSnapshot { version?: 1; id?: string; events?: SessionEvent[] }
export interface SessionStatus { id: string; eventCount: number; messageCount: number; annotationMessageCount: number; lastSeq: number; lastTermination: Termination | null }
export class Session {
  constructor(snapshot?: SessionSnapshot);
  readonly id: string; readonly events: SessionEvent[];
  append(type: string, payload: Record<string, unknown>, traceId?: string): SessionEvent;
  messages(options?: { kind?: string; upTo?: number }): Array<{ role: string; content: string; kind?: string; seq: number; [key: string]: unknown }>;
  status(): SessionStatus;
  toJSON(): SessionSnapshot;
}
export class ThreadThink {
  constructor(options?: ThreadThinkOptions);
  static create(options?: ConfigLoadOptions): Promise<ThreadThink>;
  readonly ready: Promise<void>; readonly provider: ProviderAdapter; readonly tools: ToolRegistry; readonly session: Session;
  readonly config: ThreadThinkOptions;
  readonly rag: { add(text: string, metadata?: Record<string, unknown>): Promise<{ id: string; chunkCount: number }>; search(query: string, options?: { topK?: number; signal?: AbortSignal }): Promise<Array<{ id: string; content: string; score: number; documentId: string; metadata: Record<string, unknown> }>> };
  readonly providers: ReturnType<typeof createProviderRegistry>;
  registerTool<A, V>(tool: Tool<A, V> | LegacyTool): () => Promise<boolean | void>;
  loadPlugin(spec: string | PluginSpec): Promise<PluginHandle>;
  addPreStepHook(hook: PreStepHook): () => void;
  addDocument(text: string, metadata?: Record<string, unknown>): Promise<{ id: string; chunkCount: number }>;
  chat(message: string, options?: ChatOptions): Promise<ChatResult>;
  annotate(options: ChatOptions & { selectedText: string; question: string; source?: string; thread?: unknown[] }): Promise<ChatResult>;
  dispose(): Promise<void>;
}
export function runAgent(options: AgentOptions): Promise<ChatResult>;
export function createToolRegistry(options?: ToolLimits & { tools?: Array<Tool<any, any> | LegacyTool> }): ToolRegistry;
export const calculatorTool: LegacyTool;
export function createMockProvider(options?: MockProviderOptions): MockProvider;
export function createOpenAICompatibleProvider(options?: ProviderOptions): ProviderAdapter;
export function createAnthropicProvider(options?: ProviderOptions): ProviderAdapter;
export function createProviderRegistry(adapters?: Array<ProviderAdapter & { supports(provider: string): boolean }>): { register(adapter: ProviderAdapter & { supports(provider: string): boolean }): () => void; resolve(provider?: string | ProviderAdapter, options?: ProviderOptions & MockProviderOptions): ProviderAdapter };
export const DEFAULT_CONFIG: Readonly<ThreadThinkOptions>;
export function loadConfig(options?: ConfigLoadOptions): Promise<ThreadThinkOptions>;
export function mergeConfig<T extends Record<string, unknown>>(...layers: T[]): T;
export function loadPlugin(spec: string | PluginSpec, registry: ToolRegistry, options?: { cwd?: string }): Promise<PluginHandle>;
export function loadPluginsFromDirectory(directory: string, registry: ToolRegistry, options?: { cwd?: string }): Promise<PluginHandle[]>;
export function assembleContext(context: ContextInput, options?: { sections?: ContextSection[]; budgets?: Record<string, number> }): Promise<{ messages: Message[]; sections: ContextSectionResult[] }>;
export function createContextSections(overrides?: Record<string, Partial<ContextSection> | false>): ContextSection[];
export function estimateTokens(text: string): number;
