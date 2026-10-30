<div align="center">

# 💬 ThreadThink

**批注式 AI 对话与可回放 Agent 工具**

[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

ThreadThink 支持在 AI 回答中选中文字、创建独立批注追问，并将对话、批注和工具调用记录为可寻址的事件。可以查看过去的状态、从某条记录分叉、逻辑回退，或用录制的模型响应和工具结果重跑 Agent 来检查行为一致性。

Web、SDK 和 CLI 共用同一个编排器。SDK/CLI 默认使用无需凭据的 mock provider；Web 在用户设置中配置模型。设计与本轮状态见 [design.md](design.md)，实际验证结果见 [QUALITY_REPORT.md](QUALITY_REPORT.md)。

## 核心能力

- **独立批注支线**：引用附近原文、截至目标消息的主线历史、父子批注问答链按节组装；批注回答可审计，但不进入后续主线上下文。
- **锚定与恢复**：块 ID、偏移、SHA-1 指纹和引文回退；歧义不猜测，失效批注显示“内容已变更”并保留引用。支持修改问题、重新回答、标为已解决和侧栏固定。
- **流式批注**：生成中即可标注，显示“未保存”草稿；主回答保存后顺序保存批注并生成回答。保存失败保留明确错误与重试入口。
- **Agent 与 Trace**：规划步骤、工具执行、观察、失败反思与有限重试；记录上下文、provider 响应、工具原始值与呈现值、用量和终止原因。
- **事件回溯**：历史查看、复制分叉、逻辑回退、软删除；事件仅追加，旧数据幂等迁移。
- **工具与 MCP**：calculator、web_search、fetch_url、doc_search；输入/输出 JSON Schema、取消、超时、大小与并发限制；鉴权 MCP HTTP 接口。
- **知识库**：用户隔离的 TXT/Markdown 文档上传、自然段分块、标题路径和向量检索；PDF 仅支持有限文本子集，详见边界。
- **开发者入口**：ESM SDK、CLI、配置 profile、provider 适配器、工具插件与 dispose、TypeScript 声明、testkit 和可运行示例。

## 运行 Web 应用

需要 Node.js 22 的近期版本（本轮使用 22.21.1）和 npm。请同时安装根目录与后端依赖；后端也会引用根目录的共享 core。

```bash
npm ci
npm ci --prefix server
cp .env.example .env
```

在 `.env` 配置：

| 变量 | 用途 |
|---|---|
| `JWT_SECRET` | JWT 签名密钥，部署时设置独立随机值 |
| `ENCRYPTION_SECRET` | API Key 加密密钥，至少 32 字符 |
| `PORT` | 后端端口，默认 3000 |
| `HOST` | 监听地址，默认 0.0.0.0 |
| `DB_PATH` | SQLite 文件路径 |
| `CORS_ORIGIN` | 开发前端 origin，默认 http://localhost:5173 |

```bash
# 终端 1
npm run dev --prefix server

# 终端 2
npm run dev
```

访问 http://localhost:5173，注册后在设置中填写 API Key、API 地址、模型名称和系统提示词。支持 OpenAI-compatible 与 Anthropic 协议；默认 Web 地址为 DeepSeek 的 chat completions 接口。模型名称请按所用服务配置。本轮不调用真实模型服务。

### 使用批注和历史

1. 发送问题，在 AI 回答中选中文字，点击“对此追问”。
2. 批注卡片支持继续追问、修改问题、重新回答、已解决状态和左右侧栏固定。
3. 生成期间创建的批注先作为本地草稿显示；“未保存”提示消失后才代表已保存。草稿失败时可重试保存，关闭或刷新页面前应处理未保存内容。
4. 顶部或消息旁“历史 / Trace”打开事件记录；选择记录后可查看当时状态、分叉或回退。历史查看期间禁用编辑，返回当前后恢复。
5. “回放此执行记录”使用录制数据离线重跑编排，不重新访问模型或执行外部工具。缺少必要数据的旧 Trace 会明确报告无法重执行。
6. “清空”会追加回退到起点的事件；“删除对话”为软删除。这两者都不物理擦除历史。

## SDK 与 CLI

无需数据库、Web 服务或 API Key：

```bash
npm run tt -- chat "解释一下 RAG" --no-session
npm run tt -- tools list
npm run tt -- session status
```

默认输出 `Mock: ...`，用于验证使用流程。CLI 默认持久化到当前目录 `.threadthink/session.json`；`--no-session` 禁止读写会话，`--session` 可指定路径。包尚未发布，可在其他项目中用 `npm install /absolute/path/to/threadthink` 本地安装。

```js
import { ThreadThink } from 'threadthink';

const app = new ThreadThink();
try {
  const reply = await app.chat('你好');
  console.log(reply.content, reply.termination.reason);
} finally {
  await app.dispose();
}
```

- [Getting Started](docs/getting-started.md)：配置文件、profile、环境变量、CLI 与 SDK 入门。
- [插件开发指南](docs/plugins.md)：工具 schema/render/presentationMeta、插件加载与释放、自定义 provider。
- [API 参考](docs/api.md)：SDK 方法、回调、事件、终止原因、会话与测试辅助。
- [examples/](examples/)：自定义工具、自定义 provider、RAG、批注四个离线示例。

SDK 默认仅注册 calculator，知识库为内存存储；Web 宿主额外提供网络工具、用户鉴权和 SQLite 持久化。

## HTTP API

除注册、登录和健康检查外，接口均需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/register`、`/api/auth/login`、`/api/auth/refresh` | 认证 |
| GET / POST | `/api/conversations` | 列表 / 创建 |
| GET | `/api/conversations/:id/messages` | 当前主线消息 |
| DELETE | `/api/conversations/:id` | 软删除 |
| POST | `/api/chat/stream` | 主线 SSE，body 为 `{conversationId,message}` |
| POST / GET | `/api/annotations` | 创建 / 按 `?conversationId=` 查询 |
| PUT | `/api/annotations/:id` | 更新问题、状态或锚 |
| POST | `/api/annotations/:id/reply` | 独立批注 SSE |
| GET | `/api/conversations/:id/events` | `after`/`upTo` 事件查询 |
| GET | `/api/conversations/:id/replay?upTo=seq` | 派生指定历史状态 |
| POST | `/api/conversations/:id/fork` | `{seq,title?}` 创建分叉 |
| POST | `/api/conversations/:id/rollback` | `{seq}` 逻辑回退，0 为起点 |
| GET | `/api/conversations/:id/traces`、`/api/conversations/:id/traces/:traceId` | Trace 列表 / 详情 |
| POST | `/api/conversations/:id/traces/:traceId/replay` | 录制数据驱动的离线重跑 |
| POST | `/api/mcp` | MCP JSON-RPC：initialize、tools/list、tools/call、ping、取消 |
| GET / PUT | `/api/settings` | 用户设置 |
| GET / POST / DELETE | `/api/documents`、`/api/documents/upload`、`/api/documents/:id` | 知识库列表 / 上传 / 删除 |
| GET | `/api/health` | 健康检查 |

主线和批注共用 SSE：`token`、`tool_start`、`tool_end`，以及唯一的终止事件 `done` 或 `error`。`done` 包含服务端消息 ID、事件 seq、traceId、终止原因与用量。同一用户同一对话生成时，第二次生成、回退和删除返回 409。

MCP 实现为无状态 HTTP JSON 响应，不提供 GET/SSE 会话订阅；通知返回 202。默认拒绝带浏览器 Origin 的 MCP 请求；宿主可以显式配置 allowedOrigins。MCP 工具使用与 Web 相同的用户作用域和输入/输出校验。

## 测试、行为评测与构建

```bash
npm test                         # 前端 + SDK
npm test --prefix server          # 后端单元与临时 SQLite 集成测试
npm run test:types                # 公共类型声明
npm run build
npm run eval:mock -- --runs 3
npm run eval:mock -- --negative-control  # 故意触发失败，预期退出码 1
```

评测包含 8 个任务，检查完成率、工具及参数正确率、轮数/已报告用量、重复运行一致性，覆盖注入夹具、上下文干扰和真实鉴权路由越权探针。mock 通过不代表真实 provider 的安全性或回答质量；没有上报的 token 用量保留 `null`。

CI 执行前后端测试、SDK 类型检查、mock 评测与构建，成功后构建 Docker 镜像。实际测试数量、浏览器交互与容器验证见 [QUALITY_REPORT.md](QUALITY_REPORT.md)。

## Docker

```bash
# 先在 .env 中配置 JWT_SECRET 与 ENCRYPTION_SECRET
docker compose up -d --build
docker compose logs -f
# 停止时保留数据卷
docker compose down
```

前端 http://localhost:8080，由 Nginx 代理 `/api/` 到 backend；后端端口 3000。SSE 关闭代理缓冲，数据库持久化到 `threadthink-data`。前后端镜像均从仓库根目录构建：

```bash
docker build -t threadthink-frontend .
docker build -f server/Dockerfile -t threadthink-backend .
```

## 实现边界

- 块 ID 采用内容指纹 + 同内容出现序号，未实现持久 UUID 或 CRDT。跨块选区使用引文与上下文回退；无法消歧时保留 outdated 批注。完全相同内容的历史身份不作额外保证。
- 上下文预算是保守 UTF-8 字节估算，独立于 provider 实测 token。历史和来源可按节裁剪，自定义 section 可接摘要器。
- 工具限制覆盖超时、取消、输入输出大小和并发；插件仍在宿主 Node 进程执行，必须是可信代码，不是隔离任意代码的 VM/OS 沙箱。
- `fetch_url`/搜索使用 DNS 全地址校验和连接地址固定、拒绝重定向、限制响应体。真实公网和模型调用未纳入本轮验证。
- RAG 按用户检索 Top-5 独立 chunk；自然段之间不重叠，超长段落内部按句子拆分。检索命中后的相邻段落扩展未实现。批注原文上下文会截取引用附近内容。
- PDF 仅支持狭义、未压缩 ASCII literal-Tj 文本，不是通用 PDF 解析器，也不支持 OCR。
- 不做插件市场、遥测、多人协作或横向部署扩展；完整说明见 [设计边界](design.md)。

## 目录

```text
core/             共享编排、provider、上下文、工具、SDK、类型与 testkit
bin/tt.js         CLI
src/              原生 JS 前端、批注装饰、历史与 Trace
server/src/       Fastify、SQLite 事件与迁移、鉴权、知识库、MCP
examples/         四个离线示例
evals/            行为任务、mock runner 与 Trace replay runner
tests/            前端和 SDK Vitest 测试
server/tests/     后端 node:test 测试
docs/             开发者文档
```

本项目使用 [MIT 许可证](LICENSE)。
