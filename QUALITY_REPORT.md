# ThreadThink 质量验证记录

验证日期：2026-09-17

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
| 前端 Vitest | 通过 | 8 个测试文件，70 个测试通过 |
| 前端生产构建 | 通过 | Vite build 成功 |
| 后端 Node 原生测试 | 通过 | 36 个测试通过 |
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
- 自然段级分块：普通段落各自独立、段落间无重叠、顺序保持、CRLF/纯空格行分隔、段落内部软换行保留；
- Markdown 标题路径：一级/多级章节路径、同级标题替换、连续标题、ATX 尾部井号、代码围栏内 `#` 不视为标题、TXT 不解析标题；
- 超长段落按句子边界二次切分，重叠仅发生在同一段落子块之间；单句超长时字符级兜底且内容无丢失；
- 分块元数据：embedding 输入为「标题路径 + 正文」、段落序号、超长拆分标记入库与检索回传；
- 数据库迁移：新建库含全部元数据列，旧库幂等补列且旧向量行保持可检索、不自动重建 embedding；
- 文档删除级联和用户检索隔离；
- `doc_search` 返回最多 5 条独立 chunk，不追加相邻段落；
- 狭义基础 PDF 文本子集及不支持 PDF 语法拒绝；
- calculator 白名单和 JavaScript 注入回归；
- fetch_url 协议、字面量内网地址和重定向基础校验；
- 前端 SSE 网络分块、UTF-8 分片、CRLF、多行 data、EOF 和异常收尾；
- 批注高亮恢复：单次/重复文字定位（rawContext 消歧与无上下文回退）、跨节点选区高亮（splitText 切分）、多批注互不偏移、流式结束后全量重渲染恢复；
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
11. RAG 曾使用滑动窗口（1000 字/块 + 100 字重叠）按字符切分，检索单元可能与自然语义无关；现改为自然段级单元，Markdown 标题路径作为 embedding 上下文，仅超长段落内部做句子级二次切分与局部重叠。
12. 批注高亮恢复曾只支持选中区间完整落在单个文本节点内——选中文字一旦跨加粗/代码等格式节点，重排后高亮丢失；补测时发现并修复（文本节点快照 + 区间相交切分），新增跨节点与重渲染恢复用例。

## 尚未验证或已知边界

- Docker image build 和 Compose smoke test 因环境缺少 Docker CLI 未执行；
- 命中后的相邻段落补充（context expansion）尚未实现，当前只返回用户级 Top-5 独立 chunk；
- `fetch_url` 尚未实现 DNS 解析后的 IP 校验、DNS rebinding 防护和完整响应体大小限制；
- Anthropic tool_use 已完成响应形状适配，但仍需要目标服务商环境端到端验证；
- PDF 处理只支持代码中明确声明的狭义、未压缩 ASCII literal-Tj 子集，不是通用 PDF 解析器，也不支持 OCR；
- 真实 AI、Embedding、网页服务未调用，相关链路使用 mock/stub 验证协议和错误处理。

未在以上“已通过”之外声明覆盖率、召回率、线上成功率或缺陷数量。