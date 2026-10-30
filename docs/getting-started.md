# 10 分钟运行 ThreadThink SDK 与 CLI

需要 Node.js 22 或更新版本。SDK 使用原生 ESM，无需启动 Fastify、数据库、浏览器或配置密钥。仓库保留 `private: true`，本次没有发布 npm 包；以下命令从源码或本地安装运行。

```sh
npm ci
npm run tt -- chat "解释一下 RAG" --no-session
npm run tt -- tools list
npm run tt -- session status
```

默认 provider 是 `mock`，会回显 `Mock: ...`，用于验证流程，不代表真实模型质量。CLI 默认在当前目录 `.threadthink/session.json` 追加会话事件；再次 `chat` 会从事件派生历史。`--no-session` 不读写文件，`--session ./demo.json` 指定另一份会话，`--json` 输出回复、工具结果、终止原因和用量。可通过管道输入问题。会话采用独占锁和临时文件原子替换，包含完整输入与工具结果，请按业务数据保管。

在另一个项目中本地安装：

```sh
npm install /absolute/path/to/threadthink
npx tt chat "你好" --no-session
```

```js
import { ThreadThink } from 'threadthink';

const app = new ThreadThink();
try {
  const reply = await app.chat('你好', { onToken: text => process.stdout.write(text) });
  console.log(reply.termination.reason);
} finally {
  await app.dispose();
}
```

SDK 的 `chat()` 返回对象，文本在 `reply.content`。它默认使用内存会话，可用 `app.session.toJSON()` 导出，再通过构造参数 `session` 恢复。一次实例同时运行一个任务；并发使用独立实例。`dispose()` 取消运行中的任务，卸载插件和工具并释放 provider。

## 配置与 profile

CLI 自动读取当前目录 `threadthink.config.json`。SDK 构造函数只用显式参数；需要读取文件时使用 `await ThreadThink.create({ path, profile, overrides })`。

```json
{
  "provider": "mock",
  "persona": "你是技术文档助手。",
  "rag": { "chunkSize": 1000, "overlap": 100, "topK": 3 },
  "contextBudgets": { "history": 8000, "rag": 6000, "quote": 2000 },
  "toolSettings": { "calculator": true },
  "pluginDirectory": "./tools",
  "plugins": [],
  "profiles": {
    "brief": { "persona": "用简洁中文回答。", "rag": { "topK": 1 } }
  }
}
```

```sh
npm run tt -- chat "你好" --profile brief --set '{"maxToolRounds":3}'
```

叠加顺序是默认配置、配置文件、选中的 profile、`TT_PROVIDER` / `TT_MODEL` / `TT_API_BASE` / `TT_API_KEY` 环境变量、显式 overrides/CLI flags。对象递归合并，数组整体替换。未知 profile、无效预算或分块配置直接报错。插件路径相对配置文件目录解析。`contextBudgets` 是保守 UTF-8 字节预算，用于分节裁剪，不是 provider 实测 token 数。

内建 provider 名称为 `mock`、`openai-compatible`、`anthropic`。后两者抽取自已有服务端双协议传输，并支持 `providerOptions: { apiBase, model, apiKeyEnv, timeoutMs, maxTokens }`；API Key 也可显式注入。默认环境变量分别为 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`。适配器可用注入的 `fetch` 离线测试。本次仅验证 mock/stub 网络，不调用真实服务，也不宣称其模型效果已验证。生产模型和 endpoint 应明确配置。

## 示例与验证

四个示例全部无需网络或凭据：

```sh
node examples/custom-tool.js
node examples/custom-provider.js
node examples/rag.js
node examples/annotation.js
npm run test:sdk
npm run test:types
npm run eval:mock
```

SDK 默认只注册无宿主依赖的 calculator。Web 服务另注册 web_search、fetch_url、doc_search；SDK 自定义检索可用 `app.addDocument()` 与 `app.rag.search()`。内存 RAG 的 mock embedding 仅用于确定性测试。

继续阅读 [插件开发指南](plugins.md) 与 [API 参考](api.md)。
