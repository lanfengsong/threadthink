# ThreadThink 质量验证记录

验证日期：2026-10-30。本记录对应当前工作区的 design 升级实现；未提交、未发布 npm 包，未连接真实 AI/Embedding provider。

## 已执行检查

| 检查 | 结果 | 证据与范围 |
|---|---|---|
| `npm test` | 通过 | 12 个测试文件、154 项通过，包含前端与 SDK；SDK 19 项属于该总数，不重复相加 |
| `npm test --prefix server` | 通过 | 131 项通过，0 失败；临时 SQLite + Fastify 与受控网络替身 |
| `npm run test:types` | 通过 | 公共 SDK/testkit 声明通过严格 TypeScript 编译 |
| `npm run build` | 通过 | Vite 8.3.5 生产构建 |
| `npm run eval:mock -- --runs 3` | 通过 | 8 个任务 × 3 次 = 24 次；完成率、工具正确率、一致性均为 1 |
| 评测负对照 | 通过 | 故意泄漏的 runner 被判失败，CLI 返回预期退出码 1 |
| CLI/SDK 本地安装 | 通过 | 临时目录 `npm pack`、独立安装、公开 SDK 导入和 `tt tools list` 实际运行；没有发布 |
| 四个开发者示例 | 通过 | 自定义工具、自定义 provider、内存 RAG、批注隔离，均离线运行 |
| Chrome 浏览器交互 | 通过 | 注册、设置、工具聊天、批注/子追问、Trace 回放、历史只读、分叉、回退；无 pageerror |
| 流式草稿浏览器交互 | 通过 | 后续 token 保留高亮；两条草稿排队、固定卡片 ID 替换、刷新恢复、保存失败和重试；无 pageerror |
| Docker 镜像 | 通过 | 前端 Nginx 与后端 Node 22 Alpine 均已构建，使用仓库根目录作为 context |
| 容器 HTTP smoke | 通过 | 独立临时网络：静态页面、Nginx 代理、健康检查、注册、事件列表、MCP 鉴权、calculator 返回 14 |
| 依赖审计 | 通过 | 根目录、server 均报告 0 已知漏洞；锁文件已同步。这是审计时的公告结果，不是无漏洞保证 |
| `git diff --check` | 通过 | 无空白错误 |

本机使用 Node.js 22.21.1；Vitest 更新到 5.0.5，bcrypt 更新到 6.0.0，并更新了锁文件中受公告影响的兼容依赖。依赖安装后重新执行功能回归与镜像构建。没有把任何失败命令通过 `|| true` 当作成功。

## 实现与覆盖

### 共享 Agent、上下文与 SDK

- Web、SDK、CLI 共用 `runAgent`。显式 plan、工具执行、observe、reflect/retry、失败次数和工具轮数上限、结构化终止原因。
- pre-step hook 拒绝后不再调用模型；取消、provider 异常、事件写入异常不会伪装为成功。
- 工具结果跨轮隔离，避免后续调用复用上一轮值；模型截断或拒绝时不执行不完整工具参数。
- 工具错误文本只保留在工具消息和审计中，不拼接为 system 指令；有恶意 error 的两轮反思回归。
- persona/history/rag/source/thread/quote/question 分节独立替换、Unicode 与 JSON 转义预算、资料与指令分离。
- 配置 profile/env/patch、prototype pollution 拒绝、实例隔离、目录/npm 插件（含 import-only exports）、注册/卸载、失败回卷与 dispose。
- SDK 无数据库/服务环境依赖；CLI 的会话锁、原子保存和取消；公共类型和 testkit 可供第三方使用。

### 事件、历史与离线回放

- SQLite 事件 UPDATE/DELETE/REPLACE 受到约束；旧消息、批注 JSON、工具和日志幂等迁移。旧表是兼容投影，事件建立后不从旧表覆盖历史。
- `upTo` 派生消息与批注；copy-on-fork ID 重映射，原线不变；rollback 隐藏后续派生状态而保留审计；删除为软删除。
- 事件/Trace/分叉/回退/批注 API 均检查用户归属；生成期间拒绝冲突的生成、回退与删除，断开 SSE 后释放锁。
- 从录制的 provider 响应和工具结果重跑同一编排器，对比输入上下文、工具名称与参数、最终回答和终止原因。
- 工具卡片由事件按 trace 或旧 message ID 派生，重新加载、历史查看、分叉都保留结果；不读可变工具表补历史，不执行工具副作用。
- 批注工具卡片关联最新有效回复；历史截点不读未来结果，旧兼容表篡改不会改变事件回放。

### 批注回答与前端

- 创建批注后只使用服务端 ID；流式主回答的用户/assistant ID 在 done 同步。
- 批注走专用 reply SSE，持久化 `kind='annotation'` 和 annotation_id；主线只使用 chat 消息。嵌套批注只携带截至目标消息的历史与前序问答。
- 长原回答的尾部引用仍保留附近内容与相邻补充，空引用和无效锚拒绝；父链、消息归属和回退后的可见性校验。
- SHA-1/旧 FNV、精确锚校验、重复引用上下文消歧、跨格式节点高亮、失效标记与恢复。未变块插入/删除/重排时复用 DOM。
- 流中批注有明确 draft/saveState，源回答完成后顺序保存并独立回答；草稿未保存不冒充持久化，保存失败可重试，主回答失败保留引文与错误。
- 服务端 ID 替换同步高亮、卡片与固定状态；保存前使用最终块锚；重新加载修复锚与状态，历史渲染不写数据。
- 子批注、问题编辑、重新回答、解决/重新打开、旧 JSON 只读兼容；重新生成过程中不提前把子批注标为失效。
- 真实浏览器验证了历史只读、Trace 重跑一致、分叉和回退。截图检查发现并修复手机侧栏挤占正文与浮层背景透出问题。

### 工具、网络与 MCP

- 参数/输出 JSON Schema、JSON 深度/节点/字节上限、稀疏数组预检、render/presentation 限制、超时、取消、并发和卸载。
- fetch/search 对 DNS 返回的全部地址校验并将连接固定到校验 IP，拒绝私网、保留地址与重定向，避免再次解析和连接池绕过；响应体最多 2 MiB。
- HTML 抽取使用线性扫描，覆盖大体积恶意标签输入；Embedding 有取消、超时、响应体大小、向量合法性与索引重排校验。
- MCP initialize/list/call/ping、schema、协议错误、通知、按用户隔离的取消、鉴权和 Origin 校验。
- 原有认证、文档上传、用户隔离、自然段/章节分块、基础 PDF 子集、计算器输入和 SSE 分片/EOF 回归继续通过。

## 行为评测的含义

8 个任务覆盖算术、多轮工具、文档检索、引用问答、RAG 注入、工具结果注入、上下文干扰、越权重放。工具正确率由工具名与参数独立计算，不信任 runner 自报 `correct`；稳定失败仍是失败。

24 次运行中 provider token 用量覆盖率为 **0/24**，因此用量是 **unknown/null**，不能把字符数或上下文预算当作实测 token。平均工具轮数为 0.71。越权任务访问真实 Fastify 鉴权路由和临时 SQLite；其他 provider 回复及检索/网页结果采用脚本夹具，真实编排、计算器、上下文和工具校验仍运行。

这些结果验证控制流、记录一致性和评测判定，不证明真实模型抵御提示注入的能力、实际任务完成率、线上延迟或模型成本。

## 浏览器与容器的复核方式

浏览器验证使用本机 Chrome + 临时 Playwright 驱动，连接真实 Vite/Fastify/SQLite 和本地 mock 模型服务。临时模型按延迟分片输出，以在主回答完成前创建草稿；保存失败场景只拦截一次批注 POST，然后验证重试恢复。最终增加了主线/批注工具卡刷新恢复、手机菜单开关与选择对话后自动收起的断言。全程检查浏览器 pageerror，并实际查看桌面、手机与历史截图。

浏览器驱动为本轮临时验证文件，未加入 npm 测试依赖；需要反复执行同样的环境启动与交互时，可通过 `/run-skill-generator` 固化为项目运行说明。

容器验证使用本轮专用网络和无用户数据卷的临时容器，未停止现有用户服务。通过 Nginx 的 `/api/` 代理访问后端，验证无 JWT 的 MCP 请求为 401，注册后 tools/list 成功，tools/call 的 `2*(3+4)` 返回 14。镜像构建与连接验证已执行；没有将其表述为完整 Compose 部署演练。

可重复执行的仓库命令：

```bash
npm ci
npm ci --prefix server
npm test
npm test --prefix server
npm run test:types
npm run build
npm run eval:mock -- --runs 3
npm run eval:mock -- --negative-control # 预期退出 1
npm audit
npm audit --prefix server
docker build -t threadthink-frontend .
docker build -f server/Dockerfile -t threadthink-backend .
```

## 保留边界

- **块身份**：内容指纹 + 同内容出现序号，并非持久 UUID/CRDT。重复内容存在历史身份限制；跨块选区仅引文回退。无法消歧则展示 outdated，不宣称始终精确挂载。
- **上下文预算**：默认使用保守 UTF-8 字节数；不是模型 tokenizer，也不等同摘要质量保证。
- **工具执行**：可信插件的协作式资源限制，不是 VM/OS 隔离，无法终止任意同步死循环。
- **Trace**：旧记录缺 provider 响应时只提供记录查看；运行时自定义 hook 无法序列化时可能报告上下文差异。
- **MCP**：无状态 Streamable HTTP JSON 模式，没有 GET/SSE 会话订阅。
- **SDK**：会话和 RAG 默认内存存储，CLI 会话可落 JSON；不包含 Web 用户鉴权、数据库迁移或浏览器锚解析。
- **PDF/RAG**：PDF 仅未压缩 ASCII literal-Tj 子集，不支持 OCR；文档检索仍为独立 Top-5 chunks，未扩展命中邻段。
- **外部验证**：未调用真实 AI、Embedding、搜索或网页服务；未进行线上压测、覆盖率统计或真实模型安全评估。
- **范围**：不做插件市场、遥测、CRDT、多端客户端或水平扩展；npm 包未发布。

没有在上述证据之外声明覆盖率、线上成功率或“全部安全问题已解决”。
