# ThreadThink 质量验证记录

验证日期：2026-09-14

## 已执行命令

```bash
npm test
npm run build
cd server && npm test
```

当前执行环境没有系统级 Node/npm；本次验证使用临时下载并通过 SHA-256 校验的 Node.js v22.21.1 运行时，依赖使用两个 lockfile 安装。该临时运行时不属于项目提交内容。

## 结果

| 检查项 | 结果 | 结果明细 |
|---|---|---|
| 前端 Vitest | 通过 | 7 个测试文件，52 个测试通过 |
| 前端生产构建 | 通过 | Vite build 成功 |
| 后端 Node 原生测试 | 通过 | 32 个测试通过 |
| JavaScript 语法检查 | 通过 | `src/`、`server/src/`、两侧测试文件均通过 `node --check` |
| `git diff --check` | 通过 | 无空白错误 |
| Docker build/smoke test | 未执行 | 当前环境没有 Docker CLI |

## 覆盖范围

- 注册、登录、邮箱和密码参数校验、重复注册、错误密码；
- JWT 保护接口和两个用户之间的会话资源隔离；
- Chat conversation 所属校验，阻止跨用户 IDOR；
- OpenAI-compatible 流式回答、SSE 输出和消息持久化一致性；
- 文档 TXT/Markdown 上传、扩展名/MIME/空文件/大小/路径校验；
- Embedding HTTP 错误、响应 schema、索引重排、向量合法性和失败回滚；
- 文档分块上限、段落边界、长句切分和重叠；
- 文档删除级联和用户检索隔离；
- 狭义基础 PDF 文本子集及不支持 PDF 语法拒绝；
- calculator 白名单和 JavaScript 注入回归；
- fetch_url 协议、字面量内网地址和重定向基础校验；
- 前端 SSE 网络分块、UTF-8 分片、CRLF、多行 data、EOF 和异常收尾；
- 前端聊天并发锁、网络异常解锁、批注 token 累加。

## 已修复的主要缺陷

1. Chat 接口未校验 conversation 所属用户，存在跨用户读取/写入风险。
2. 文档检索曾通过模块级用户状态传递 userId，并发请求可能串扰。
3. 文档 Embedding 失败时可能留下孤儿 documents 记录。
4. 聊天曾先保存非流式结果、再重新请求流式结果，数据库内容可能与前端不一致。
5. calculator 校验可被函数名/表达式边界绕过。
6. fetch_url 只覆盖少量内网地址且自动跟随重定向。
7. Anthropic `stop_reason: tool_use` 未转换为内部工具调用格式。
8. 前端 SSE EOF 残留事件可能丢失，网络失败可能使发送状态卡死。
9. CI 曾使用 `npm test || true`，后端没有真实 test script，可能产生假绿。
10. Docker Compose 曾硬编码 JWT 和加密密钥，现改为环境变量注入。

## 尚未验证或已知边界

- Docker image build 和 Compose smoke test 因环境缺少 Docker CLI 未执行；
- `fetch_url` 尚未实现 DNS 解析后的 IP 校验、DNS rebinding 防护和完整响应体大小限制；
- Anthropic tool_use 已完成响应形状适配，但仍需要目标服务商环境端到端验证；
- PDF 处理只支持代码中明确声明的狭义、未压缩 ASCII literal-Tj 子集，不是通用 PDF 解析器，也不支持 OCR；
- 真实 AI、Embedding、网页服务未调用，相关链路使用 mock/stub 验证协议和错误处理。

未在以上“已通过”之外声明覆盖率、召回率、线上成功率或缺陷数量。
