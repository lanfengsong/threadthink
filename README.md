<div align="center">

# 💬 ThreadThink

**批注式 AI 对话工具** — 打破线性对话，在 AI 回答中直接批注追问

[![Node.js](https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/lanfengsong/threadthink/blob/master/LICENSE)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](.github/workflows/ci.yml)

</div>

---

## 📖 项目简介

**ThreadThink** 是一个"批注式"的 AI 对话工具。与普通聊天机器人不同，你可以在 AI 的回复中**选中任意文字**，以批注的形式对局部内容进行追问，从而将线性对话升级为**结构化、可回溯的思维线程**。

- 🧩 **纯原生前端**：零框架依赖，基于 Vanilla JS + Vite 构建
- 🔌 **多模型兼容**：支持 DeepSeek / Anthropic / OpenAI 及所有 OpenAI 兼容 API
- 🔧 **内置工具扩展**：AI 可调用网页搜索、文档检索、数学计算等工具
- 📚 **RAG 知识库**：上传 PDF / TXT / Markdown 文档，构建个人知识库

## ✨ 核心功能

<table>
<tr>
<td>

### 🧵 批注式对话
- 选中 AI 回复中的任意文字，一键"对此追问"
- 追问以批注形式挂载在原回答上，保留完整上下文
- 支持将批注卡片固定到左右侧边栏，随时回看

### 🗂️ 多对话管理
- 侧边栏对话列表，随时切换历史会话
- 自动生成对话标题（取首条消息）
- 一键新建 / 清空 / 删除对话

</td>
<td>

### 🛠️ AI 工具调用
- **网页搜索** `web_search` — 实时获取网络信息
- **网页抓取** `fetch_url` — 读取指定 URL 内容
- **文档检索** `doc_search` — 基于向量相似度检索知识库
- **数学计算** `calculator` — 精确表达式求值
- 最多 5 轮工具循环，自动处理 `tool_calls`

### 🔐 安全与隐私
- 用户注册 / 登录（JWT 认证 + bcrypt 密码加密）
- API Key 使用 AES 加密后存储于数据库
- 支持自定义系统提示词

</td>
</tr>
</table>

## 🛠️ 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 前端 | Vanilla JS (ES Modules) | 零框架，原生 DOM API |
| 构建 | [Vite](https://vitejs.dev/) 8.x | 开发服务器 + 生产构建 |
| 测试 | [Vitest](https://vitest.dev/) 3.x + jsdom | 单元测试 |
| 后端 | [Fastify](https://fastify.dev/) 5.x | 高性能 Node.js 框架 |
| 数据库 | better-sqlite3 | 轻量级嵌入式数据库 |
| 认证 | jsonwebtoken + bcrypt | JWT + 密码哈希 |
| 部署 | Docker + docker-compose | 前端 Nginx + 后端容器 |
| CI/CD | GitHub Actions | 测试 + 构建 + 镜像构建 |

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) **22.x** 或更高版本
- npm（随 Node.js 附带）

### 1. 安装依赖

```bash
# 安装前端依赖
npm install

# 安装后端依赖
cd server && npm install && cd ..
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入你的配置：

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认值 | 说明 |
|------|:---:|--------|------|
| `JWT_SECRET` | ✅ | - | JWT 签名密钥（生产环境务必修改） |
| `ENCRYPTION_SECRET` | ✅ | - | API Key 的 AES 加密密钥（至少 32 字符） |
| `PORT` | | `3000` | 后端服务端口 |
| `DB_PATH` | | `./data/threadthink.db` | SQLite 数据库文件路径 |

### 3. 启动开发环境

```bash
# 终端 1：启动后端（端口 3000）
cd server && npm run dev

# 终端 2：启动前端（端口 5173，已配置代理）
npm run dev
```

打开浏览器访问 **http://localhost:5173**，注册账号并登录。

### 4. 配置 AI 模型

登录后点击右上角 ⚙️ 图标，填写：

- **API Key**：你的模型服务商密钥（支持 Anthropic / OpenAI / DeepSeek）
- **API 地址**：兼容接口地址，默认 `https://api.deepseek.com/v1/chat/completions`
- **模型**：如 `deepseek-chat`、`claude-sonnet-5`、`gpt-4o` 等
- **系统提示词**：自定义 AI 的默认行为

## 📖 使用指南

1. **开始对话**：在输入框输入问题，按 `Enter` 发送
2. **批注追问**：在 AI 回复中**选中文字**，点击弹出的「💬 对此追问」按钮
3. **固定卡片**：将批注卡片**拖拽**到左侧或右侧边栏固定，便于对比回看
4. **上传文档**：点击侧边栏 📁 知识库的 `+` 按钮，上传 PDF / TXT / Markdown 文件
5. **知识库检索**：对话中 AI 会自动使用 `doc_search` 工具检索你的文档

## 📁 项目结构

```
threadthink/
├── index.html              # 入口页面
├── src/                    # 前端源码（ES Modules）
│   ├── main.js             # 入口
│   ├── events.js           # 事件绑定与初始化
│   ├── api.js              # API 客户端封装
│   ├── renderer.js         # 消息渲染
│   ├── cards.js            # 批注卡片
│   ├── annotations.js      # 批注逻辑
│   ├── selection.js        # 文字选区处理
│   ├── sidebar.js          # 侧边栏与拖拽
│   ├── documents.js        # 知识库前端
│   ├── markdown.js         # Markdown 渲染
│   ├── settings.js         # 设置面板
│   └── ...
├── server/                 # 后端服务（Fastify）
│   └── src/
│       ├── index.js        # 服务入口
│       ├── config.js       # 配置加载
│       ├── routes/         # 路由：auth / chat / conversations / documents / settings
│       ├── services/       # 业务逻辑：AI / 认证 / 加密 / 文档 / 嵌入
│       │   └── tools/      # 工具注册表：web_search / fetch_url / doc_search / calculator
│       └── db/             # SQLite 连接与迁移
├── tests/                  # 单元测试（Vitest）
├── css/                    # 样式
├── docker-compose.yml      # 容器编排
├── Dockerfile              # 前端镜像（Nginx）
└── .github/workflows/ci.yml # CI 流水线
```

## 🔌 API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/register` | 用户注册 |
| `POST` | `/api/auth/login` | 用户登录 |
| `POST` | `/api/auth/refresh` | 刷新 Token |
| `POST` | `/api/chat/stream` | 流式对话（SSE） |
| `GET` | `/api/conversations` | 获取对话列表 |
| `POST` | `/api/conversations` | 创建对话 |
| `GET` | `/api/conversations/:id/messages` | 获取对话消息 |
| `DELETE` | `/api/conversations/:id` | 删除对话 |
| `GET` / `PUT` | `/api/settings` | 获取 / 更新用户设置 |
| `GET` | `/api/documents` | 获取知识库文档列表 |
| `POST` | `/api/documents/upload` | 上传文档（multipart） |
| `DELETE` | `/api/documents/:id` | 删除文档 |
| `GET` | `/api/health` | 健康检查 |

## 🧪 测试与质量门禁

前端测试使用 Vitest，后端测试使用 Node.js 原生 `node:test` 与 Fastify `inject()`。后端集成测试会创建临时 SQLite 数据库，并对 AI、Embedding 和网页请求使用可控替身，不需要真实 API Key 或公网服务。

```bash
# 前端单元测试
npm test

# 前端监听模式
npm run test:watch

# 后端单元/集成测试
cd server && npm test && cd ..

# 前端生产构建
npm run build
```

CI 会在构建 Docker 镜像前执行前后端测试；任一测试失败都会阻断流水线，不会吞掉失败结果。

当前测试重点覆盖：认证参数校验、会话资源归属隔离、Chat IDOR 回归、文档分块、工具输入安全校验、SSE 分块与 EOF 解析，以及流式聊天异常收尾。运行测试前请以 Node.js 22.x 或更高版本安装根目录和 `server/` 目录依赖。最近一次验证结果见 [QUALITY_REPORT.md](QUALITY_REPORT.md)，其中明确区分了已运行检查和未执行的 Docker 验证。

> 已知边界：`fetch_url` 当前覆盖协议、字面量内网地址和重定向基础校验，尚未实现 DNS 解析后的 IP 校验、DNS rebinding 防护和完整响应体限制；Anthropic tool_use 已做响应形状适配，但仍应在目标服务商环境中进行端到端验证。

## 🐳 Docker 部署

```bash
# 先在 .env 或当前 shell 中设置 JWT_SECRET、ENCRYPTION_SECRET
# 构建并启动全部服务（前端 :8080 + 后端 :3000）
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

- 前端由 Nginx 提供服务，并将 `/api/` 反向代理至后端容器
- 数据通过 volume `threadthink-data` 持久化，容器重建不丢失
- SSE 流式响应已配置 `proxy_buffering off`，确保实时输出

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE) 发布。

---

<div align="center">

**ThreadThink** — 让 AI 对话像思维导图一样可追溯 · Made with ❤️

</div>