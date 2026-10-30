# 工具与 provider 插件开发

CLI、SDK 和 Web 服务共享 `core/orchestrator.js` 与 `core/tools.js`。工具只执行一次操作；工具循环、事件记录、反思和次数上限由编排处理。

## 工具契约

```js
const lookup = {
  name: 'lookup',
  description: '按关键词检索本地资料',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'], additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'], additionalProperties: false,
    },
    render: (args, value) => value.answer,
    presentationMeta: (args, value) => ({ title: args.query, body: value.answer }),
  },
  async execute({ query }, { signal }) {
    signal.throwIfAborted();
    return { answer: '检索结果：' + query };
  },
  async dispose() { /* 关闭连接、释放句柄 */ },
};
const unregister = app.registerTool(lookup);
await unregister();
```

参数与返回值均用 JSON Schema 校验，参数不会被隐式转换。简写 `parameters: { query: { type: 'string' } }` 会生成必填字段的对象 schema。`output.schema` 要求 `type: 'object'`，与 MCP structuredContent 对齐；不提供输出 schema 时可返回任意有限 JSON 值。原始 `result`、模型可见的 `rendered` 和 UI 的 `presentation` 分别保存在工具事件中。错误以 `{error, code}` 返回，不经过只适用于成功结果的 renderer。

默认限制：每次 10 秒，输入 64 KiB，输出 256 KiB，同时最多 8 次，JSON 深度/节点也受限。可通过 `toolLimits` 配置；工具自己的 `timeoutMs` 只能收紧上限。卸载会中止运行中的调用，随后执行 `dispose`；同名重复注册拒绝，卸载句柄只影响自己那次注册。第三方 JavaScript 在宿主进程运行，这些是资源与取消约束，不是隔离任意 JS 的 VM/OS 沙箱；工具必须响应 `signal`，同步死循环无法被同进程计时器中断。

## 目录插件

配置 `"pluginDirectory": "./tools"` 后，每个子目录包含 `manifest.json` 和入口文件：

```json
{ "name": "greetings", "apiVersion": 1, "main": "index.mjs" }
```

`index.mjs` 可以直接导出一个工具、工具数组、`{tools:[...]}`，或 setup 函数：

```js
export default async function setup({ registerTool, config, manifest }) {
  registerTool({
    name: 'greet', parameters: { name: { type: 'string' } },
    execute: async ({ name }) => ({ message: (config.prefix || '你好') + name }),
  });
  return async () => { /* 释放插件级资源 */ };
}
```

插件级函数也可返回 `{dispose()}`。工具的 `dispose` 与插件的 cleanup 各执行一次。setup 失败时已注册的工具回滚；加载批次失败时已加载的插件释放。manifest `main` 不允许逃出插件目录。只有显式配置或调用 `app.loadPlugin()` 才加载插件；请仅运行可信插件代码。

## npm 或显式文件入口

```json
{
  "plugins": [
    "your-installed-plugin-package",
    { "path": "./tools/greetings", "options": { "prefix": "Hi " } },
    "./one-tool.mjs"
  ],
  "toolSettings": { "calculator": false }
}
```

npm 包通过其公开入口解析；使用普通 npm 安装到宿主项目后配置包名即可。`app.loadPlugin(spec)` 返回 `{name, dispose}`。`tt plugin install` 只报告尚未实现，插件市场与包管理器属于设计明确排除的范围。

## 自定义 provider

```js
const provider = {
  supports: name => name === 'local',
  async *chat(messages, { tools, signal }) {
    signal?.throwIfAborted();
    yield { type: 'text', text: '本地回答' };
    yield { type: 'done', finishReason: 'stop' };
  },
  // embed: async texts => [[...]],    // 可选，用于 RAG
  // dispose: async () => {},
};
const app = new ThreadThink({ provider: 'local', providers: [provider] });
```

`chat` 的工具事件是 `{type:'tool_call',call:{id,type:'function',function:{name,arguments:JSON.stringify(args)}}}`。不要在 adapter 中执行工具。只实现 `chat` 的 adapter 在一轮流结束后，编排收集工具请求并处理；纯文本会在该轮结束时发送给用户。需要沿用现有“同步决策 + 流式回答”协议，可另实现 `complete(messages, options)`，返回 `{content,toolCalls,finishReason,usage}`；此时 `chat` 只生成最终文本。`options.tools` 为空时不得再请求工具。

`usage` 接受 `input_tokens/output_tokens` 或 `prompt_tokens/completion_tokens`。任一轮缺少用量时，对应汇总字段为 `null`；`reportedInputTokens/reportedOutputTokens` 只代表已报告部分。SDK 不将字符估计当实测 token。`refusal` 和 `max_tokens` 响应不会执行可能不完整的工具调用。

## 使用 testkit

```js
import assert from 'node:assert/strict';
import { mockProvider, mockTool, toolCall, testTool } from 'threadthink/testkit';

const tool = mockTool({ name: 'lookup', result: { answer: '42' } });
const checked = await testTool(tool, {});
assert.deepEqual(checked.value, { answer: '42' });

const provider = mockProvider({ responses: [
  { toolCalls: [toolCall('lookup', { query: 'answer' })] },
  '42',
] });
```

`mockProvider.requests` 保存每轮输入快照；`mockTool.calls` 记录参数和请求作用域 context。`testTool` 运行真实 registry 的参数/输出校验、render 和 presentation，并自动释放工具。
