# SDK API 参考

公共 ESM 入口为 `threadthink`，测试辅助入口为 `threadthink/testkit`；两者均附 `.d.ts`。Node.js 22+，没有全局用户状态、DB 导入或网络初始化。

## ThreadThink

| 方法/属性 | 用途 |
|---|---|
| `new ThreadThink(options)` | 创建独立 provider、工具注册表和内存会话；显式参数配置 |
| `ThreadThink.create({cwd,path,profile,env,overrides})` | 读取 JSON 配置，完成插件初始化后返回实例 |
| `ready` | 插件初始化 Promise；chat/loadPlugin 已自动等待 |
| `chat(message, options)` | 执行共享编排，返回 `ChatResult` |
| `annotate({selectedText,question,source,thread,annotationId,...options})` | 将引用与来源按分节组装，写 annotation 支线事件；不污染主线历史 |
| `addDocument(text, metadata)` | 分块并用 provider.embed 存入内存知识库，返回文档 id 与 chunkCount |
| `rag.search(query, {topK,signal})` | 返回按余弦相似度排序的片段 |
| `registerTool(tool)` | 返回异步反注册句柄 |
| `loadPlugin(spec)` | 返回 `{name,dispose}` |
| `addPreStepHook(fn)` | 返回移除钩子的函数 |
| `tools` / `providers` | 当前实例的注册表 |
| `session` | 追加事件并派生消息/状态 |
| `dispose()` | 取消当前任务，释放所有插件、工具、provider；幂等 |

构造配置包括 `provider`（名称或 adapter）、`providers`（自定义 adapter 列表）、`providerOptions`、`persona`、`tools`、`builtinTools`、`toolSettings`、`toolLimits`、`plugins`、`pluginDirectory`、`rag`、`contextBudgets`、`hooks`、`session`、`maxToolRounds`（默认 5）、`maxConsecutiveFailures`（每工具默认 2）。所有配置按实例持有。

`chat` 选项：

- `onToken(text)`、`onToolStart(call)`、`onToolEnd(audit)`、`onEvent(event)`：允许异步回调。
- `signal`：取消模型或工具调用。
- `context`：字符串（作为 source）或分节材料对象 `{source,selectedText,thread,history,rag,persona}`。
- `contextMessages`：完全替换默认上下文，然后追加当前问题。
- `sections`：自定义分节定义。
- `toolContext`：传给工具的宿主能力/用户信息；`signal` 与 traceId 由编排管理。
- `upTo`：主线历史只派生到指定 seq。

`ChatResult` 为 `{content,toolCalls,traceId,termination,usage,messages,rounds}`。工具 audit 包含 `id/tool_name/arguments/result/rendered/presentation/status/durationMs`。`termination.reason` 有 `completed`、`max_tool_rounds`、`blocked`、`aborted`、`refusal`、`max_tokens`。provider/协议/回调失败抛异常并记录 error；取消或 hook 明确拦截返回结构化终止，不记录已完成的 assistant。`messages` 是本轮模型输入轨迹，不包含最后的 assistant；用户完整消息视图来自 session。

## runAgent 与 hooks

`runAgent({messages,provider,tools,hooks,context,signal,onEvent,onToken,onToolStart,onToolEnd,maxToolRounds,maxConsecutiveFailures,traceId})` 是 Web 服务、SDK、CLI 的唯一工具循环。`tools` 仅需 `getToolDefinitions/executeTool/renderToolResult`，可选 `getToolPresentationMeta`，便于录制回放替代真实副作用。

每次请求前 hook 接收 `{messages,allowed:true}` 与请求 context，可返回新的 state。`allowed:false` 阻止后续 provider 请求；hook 抛错会停止任务。钩子顺序执行，前一个拒绝后不运行后续钩子。

事件包含 `request`（初始上下文和运行限制）、`plan`（显式执行步骤）、`context`（每个模型请求的实际输入）、`provider_response`（规范化决策）、`tool_call`、`tool_result`、`observe`、`reflect`、`retry`、`done/error`。它们包含 traceId 和时间；工具结果包含耗时与可回放的呈现值。`onEvent` 必须成功后才继续相关操作，宿主可保证“模型可见即已记录”。plan 是编排的结构化执行计划，不是额外调用模型生成的隐含推理。

## 会话

`new Session(snapshot?)`、`append(type,payload,traceId?)`、`events`、`messages({kind='chat',upTo=Infinity})`、`status()`、`toJSON()`。事件读取返回深拷贝；不提供删除或覆盖事件 API。恢复时验证连续 seq。`status()` 提供 id、事件数、主线/批注消息数、最后 seq 和终止原因。

SDK 会话使用内存事件存储，CLI 导出版本为 1 的 JSON；Web 宿主使用 SQLite events 与同一编排回调。SDK 没有 Web 的鉴权、数据库迁移或持久文档存储，宿主可自行持久化 snapshot 和文档。批注 SDK 入口覆盖上下文隔离与回答，浏览器 blockId/高亮锚解析仍由 Web 应用负责。

## 注册表与辅助函数

- `createToolRegistry({tools,...toolLimits})`：注册、卸载、执行、render、MCP 定义；详见插件指南。
- `createProviderRegistry(adapters)`：`register(adapter)` 返回移除句柄，`resolve(name,config)` 解析实例；第三方 adapter 优先于内建名称。
- `createMockProvider(options)`、`createOpenAICompatibleProvider(options)`、`createAnthropicProvider(options)`：可注入传输的内建 adapter。
- `loadConfig(options)`、`mergeConfig(...layers)`：配置文件/profile/patch。
- `loadPlugin(spec,registry,{cwd})`、`loadPluginsFromDirectory(directory,registry,{cwd})`：可信代码加载与回卷。
- `assembleContext(ctx,{sections,budgets})`、`createContextSections(overrides)`、`estimateTokens(text)`：上下文分节与保守预算，估计值不用于 provider token 指标。

四个可运行示例见 `examples/`。本次真实 provider 均未联网验证；所有自动化使用 mock 或注入 fetch。
