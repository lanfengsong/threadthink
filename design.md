# ThreadThink 升级设计文档（Agent 化 + 批注锚定重构）

> **状态说明**：本文档为设计蓝图，**尚未实现**。所有"当前实现"均指 2026-09 版本代码；"目标设计"为规划内容，实现后在 QUALITY_REPORT 中对应更新。

---

## 一、升级背景与目标

### 1.1 升级动机

ThreadThink 目前是"批注式 AI 对话工具"：文本选区级挂载追问（市面空白）。升级要解决两件事：

1. **从"会干活的对话工具"升级为"可验证的 Agent 编排系统"**——2026 年 Agent 项目遍地都是，但"如何证明 Agent 可靠"（可观测、可评测、可回放）是业界公认缺口，也是目标岗位（AI 质量效能/评测）的 JD 核心要求。
2. **重做批注挂载**——当前实现（selectedText + rawContext + 全文文本匹配恢复）是业界"锚定链"的**最末层回退**，缺稳定锚、缺漂移兜底、与正文耦合。

### 1.2 设计原则

- **渐进式**：每个升级点接在现有能力上（RAG 分块、SSE 流式、工具循环、106 项测试都是资产，不推倒）
- **可验证**：每个功能升级都自带评测手段（测试/回放/指标）——这是本项目的核心竞争力
- **诚实边界**：设计文档里的"目标"不等于"已实现"；未做项（DNS 校验、真实 provider）保持标注

---

## 二、市场调研摘要（同类型项目架构）

### 2.1 对话树/非线性对话项目的粒度与存储

| 项目 | 粒度 | 存储模型（已核实） |
|---|---|---|
| stello | 会话级 | Session 森林：`parentId` 自引用；`memory`/`insight` 外置元数据；PostgreSQL |
| Prompt-Tree | 消息级 | `Node { id, parentId, content, summary, tokenCount }`；IndexedDB nodes store，parentId 建索引 |
| LibreChat | 消息级 | `conversationId + parentMessageId` 邻接表 |
| Astral-Web-UI | 消息级 | 编辑/重新生成**不覆盖**，新旧版本为兄弟节点（全项目最接近"版本"的语义） |
| Claude Code | 会话级 | **copy-on-fork**：分叉=拷贝 transcript 生成新 session id，原会话原样保留；JSONL 追加式 |
| ChatGPT | 未核实 | 官方未公开；逆向仅有 conversation_id + parent_id 线索 |

**共识**：存储全是**自引用 parentId（邻接表）**；商业产品连树都不存（直接拷贝快照）。**没有任何项目做文本选区级**。

### 2.2 文本级批注的业界标准（富文本编辑器生态，源码级核实）

三档方案对比：

| 方案 | 锚定载体 | 漂移行为 | 重锚定 |
|---|---|---|---|
| deditor（ProseMirror） | 文档内 comment **mark（只存 id）** | 随文本移动；删除→detached 标记，线程保留 | 无（detached 兜底） |
| Lexical（Meta） | 文档内 MarkNode（id=thread id） | 随文本移动；删除即丢 | 无 |
| TipTap | 文档内 comment mark（仅 commentId） | 同上 | 无 |
| **y-comments** | **外置锚：RelativePosition + 容器 id + quote/前后缀 32 字符** | 四级解析链重定位；**歧义即放弃，永不删除** | 有（selfHeal） |

**标准做法 = "锚 + 引 + 外置线程"三层**：
1. **锚**：随文档移动的稳定锚（RelativePosition / mark 只存 id）
2. **引**：创建时快照选中文本（引用 + 上下文）——位置丢失后的回退定位 + Outdated 显示内容
3. **外置线程**：评论独立于正文（ThreadStore/CommentStore），高亮是**渲染层装饰（decoration）**，正文保持纯内容

---

## 三、架构升级设计

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────┐
│  前端（Vite + 原生 JS）                                    │
│  ├─ 渲染层：Markdown → 块化 AST → 装饰渲染（批注为覆盖层）  │
│  └─ Trace 可视化：决策日志/工具调用时间线                   │
├─────────────────────────────────────────────────────────┤
│  后端（Fastify + SQLite）                                  │
│  ├─ Agent 编排层：规划 → 执行 → 反思 → 自愈（新）           │
│  ├─ 工具层：MCP 兼容协议适配（新）+ 四类工具 + 沙箱化        │
│  ├─ 批注锚定层：blockId + 偏移 + 指纹 + 引文回退（重构）     │
│  ├─ 可观测层：事件流（唯一事实源）+ Trace + 回放（新）       │
│  ├─ 回溯层：查看/分叉/截断（渲染即重放，新）                 │
│  └─ 评测层：任务评测集 + 指标 + 对抗评测（新）              │
└─────────────────────────────────────────────────────────┘
```

### 3.2 模块一：Agent 编排层（从"5 轮循环"到"规划-执行-反思"）

**现状**：`chat.routes` → 工具循环（最多 5 轮，AI 自主决定调工具）——最简单的 ReAct。

**目标**：
- 显式规划（plan）：根据用户意图产出任务清单
- 执行（act）：逐任务调用工具
- 观察（observe）：工具结果作为反馈
- **反思（reflect）+ 自愈（retry/revise）**：工具失败不直接放弃，反思后换策略重试（有次数上限）
- **决策日志**（本模块核心）：每次"AI 决策"（考虑了哪些上下文、调用了什么工具、为什么、结果如何、耗时、token）**结构化落库**——可观测/回放/评测的地基

**为什么**：Agent 项目最大的痛点是**不可复现**（"为什么这么干"答不上来）。决策日志让每次交互可追、可重放、可评测。

### 3.3 模块二：可观测层（Trace + 回放）

**目标**：
- 每次交互生成 `trace_id`，关联：用户输入 → 规划 → 各次工具调用（参数/结果/耗时/token）→ 最终回复
- **回放（Replay）**：用记录的输入+决策重跑，断言行为一致——**测试带随机性 Agent 的最可靠回归手段**
- 前端 Trace 面板：时间线可视化工具调用

**为什么**：目标岗位 JD 原话——"构建 Agent 观测体系，实现全链路追踪与多维归因分析"。

### 3.4 模块三：行为评测层（本项目的差异化主场）

**目标**：任务级评测集 + 四类指标 + 对抗评测：
- **完成率**：给定目标，Agent 是否完成
- **效率**：轮数、token 消耗
- **工具调用正确率**：调用了对的工具、对的参数吗
- **一致性**：同一任务跑 N 次，结果稳定度（Agent 非确定性的量化）
- **对抗评测**：提示注入（"忽略之前的要求"）、上下文干扰、越权重放

**为什么**：这是"测试开发做 Agent"的完整叙事——交付 Agent + 它的测量仪。

### 3.5 模块四：上下文工程层（Context Engineering）

**现状**：`buildAnnotationContext`（对话历史全量拼接——"一锅乱炖"：历史、引用、问题混在一段里，无边界、无分工）。

**目标：上下文分节（Context Sections）**——把"给 AI 的材料"按角色分装，每节有标签、有边界、有分工（类比：给厨师备菜分装袋，而不是一锅乱炖；参考 dsh 的 `system-prompt/assemble` 瀑布与 prompt sections）：

```js
// 分节注册表：加一节 = 注册一项，核心组装逻辑不动（与工具注册表同模式）
const contextSections = [
  { id: 'persona',   maxTokens: 200,   build: (ctx) => '你是批注问答助手...' },
  { id: 'history',   maxTokens: 2000,  build: async (ctx) => summaryHistory(ctx) }, // 可注入摘要
  { id: 'rag',       maxTokens: 1500,  build: async (ctx) => `相关文档：\n${await searchDocs(ctx)}` },
  { id: 'quote',     maxTokens: 200,   build: (ctx) => `【引用】${ctx.selectedText}` },
  { id: 'question',  maxTokens: 200,   build: (ctx) => `【追问】${ctx.question}` },
];
```

**关键设计**：
- **每节独立**：换 persona 不重写整段（换衣服不重做整桌菜）；加记忆摘要 = 注册一节，不动其他
- **每节可追踪**：出问题（"AI 为什么跑题"）可逐节排查——是【rag】塞太多带偏了，还是【quote】没写清
- **每节可预算**：`maxTokens` 按节设限，超限该节自行压缩（摘录/裁剪/摘要），不误伤其他节（限量发材料）
- **焦点显式化**：乱炖版里"历史"与"引用"同级（AI 分不清主次）；分节后【引用】是抓手、【历史】只是参考——回答紧扣引用，而非复述历史
- **与 3.2 编排层配合**：分节负责"输入组装"，pre-step 钩子链负责"请求前拦截/改写"——组装在前、拦截在后，两条管线正交

**参考来源**：deepseek-harness（`system-prompt/assemble` 瀑布、prompt sections、compaction 的区间替换不变量）；Prompt-Tree 的 `compressedNodeIds`；stello 的 `systemPrompt` 持久注入

### 3.6 模块五：MCP 协议兼容 + 安全补强

- 工具定义输出为 **MCP 规范**（`tool` schema）——低成本、生态词、任意 MCP 客户端可复用
- 安全补强（把已知边界变已实现）：fetch_url **DNS 解析后校验**、响应体大小限制、**工具沙箱化**（超时/资源上限）
- 批注/上下文注入作为不可信输入（提示注入防护）

### 3.7 模块六：事件日志与回溯（对话可寻址，参考 deepseek-harness）

**核心概念：事件日志为唯一事实源**（dsh 原语："模型可见即已记录"）——不存"消息数组"（状态），存**追加式事件流**（事实）；消息列表、批注列表、界面全部是**从事件流派生**的视图。类比：银行存的是**流水**，余额是流水加出来的。

**为什么**：状态设计下"回溯/审计/重放"需要额外快照体系（ChatGPT 编辑覆盖的痛点）；事件日志里这些能力**自然存在**——历史永远在（只追加不删除），任意时刻可重建。

**① 事件流表（SQLite 一张表即可，不照搬 dsh 的 JSONL/zstd/多版本迁移链）**

```sql
events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 流水号，只增
  type         TEXT,    -- 'user_message' | 'ai_message' | 'annotation_created'
                        -- | 'tool_call' | 'fork' | 'compaction' | ...
  payload      TEXT,    -- JSON：消息内容 / 批注锚 / 工具参数与结果 / 摘要区间...
  fork_from    INTEGER, -- NULL=正常线；非空=该事件之后属于分叉线（来自 seq）
  created_at   TEXT
)
```

消息/批注/界面 = 对 events 的**派生查询**；渲染函数带 `renderUpTo(seq)` 参数即可回放到任意时刻。与 3.3 可观测层的关系：**决策日志升级为事件流**（Trace 是事件的投影，回放是重放事件）。

**② 三种回溯语义**

| 语义 | 定义 | 实现 |
|---|---|---|
| 查看型 | 看某时刻对话的完整样貌（消息+批注+高亮+工具调用） | 重放至 seq 即停——零新存储、零新逻辑 |
| 分叉型 | 回到某条消息，换个问法，从那里重新走（原线保留） | 追加 `fork` 事件（`fork_from`），新叙事继续；树是派生视图，无需建树表 |
| 截断型 | 把某点之后标记为"已回退" | 追加回退事件（不物理删除——历史永远在，语义在重放时体现） |

**③ 与批注的统一：同一机制，三种呈现**（本设计的产品级洞察）

- 批注 = 给过去的某处**挂引用**（锚 = seq + 块 + 偏移）
- 回溯 = 重建过去的某处（重放至 seq）
- 分叉 = 从过去的某处**另起一线**（fork_from）

三者都建立在同一能力上：**过去可寻址**。批注子线程（4.5 的 parent_id 邻接表）与对话分叉（fork_from）在事件流上统一为"树的两种形态"。

**④ 落地顺序**：查看型（先做，成本几乎为零，产品叙事即"对话是时光机"）→ 分叉型（产品级亮点，对应 stello/Claude Code 的 branch 语义）→ 与批注统一（批注卡片提供"从此处重新对话"入口）。

**参考来源**：deepseek-harness（追加式 SessionEvent 日志、deriveMessages 派生历史、inject/followup 分离）；Claude Code（/branch、--fork-session 的 copy-on-fork）。

---

## 四、批注锚定重构（本设计重点）

### 4.1 当前实现的六项缺陷

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 无稳定锚，只存 selectedText，靠**全文文本搜索**恢复 | 内容一变（流式重排/重新生成/渲染歧义）就匹配失败或错位 |
| 2 | 无漂移兜底（无 outdated/detached 概念） | AI 回答重新生成时，批注**静默丢失** |
| 3 | 批注内嵌 `messages.annotations` JSON，与正文耦合 | 无法独立查询/分享/状态管理；并发修改有整字段覆盖风险 |
| 4 | 批注树（ann.annotations 嵌套）存在 JSON 里 | 查询、分页、排序需全量解析 |
| 5 | 高亮是"重建内容时注入"（innerHTML 全量重建） | 流式期间创建的高亮会闪失，直到 onDone 恢复 |
| 6 | 匹配靠文本内容，无指纹校验 | 相近文本可能误挂（虽已用 rawContext 消歧，仍是启发式） |

### 4.2 目标设计：分级锚定链（对齐 y-comments，适配本项目）

**① 内容块化（稳定容器）**
- Markdown 渲染升级为：解析 → **块数组**（`{ blockId, type: 'p'|'h2'|'code'|'li'..., text }`）→ 渲染
- 每块有**稳定 id**（uuid，内容不变则 id 不变）——这是锚的"容器"

**② 批注存储独立化（外置线程）**
- 从 `messages.annotations` JSON 迁出，新建表：
  ```sql
  annotations (
    id, message_id,           -- 挂在哪条消息
    block_id,                 -- 稳定容器（块）
    start_offset, end_offset, -- 块内字符区间（精确锚）
    selected_text,            -- 快照（引）
    text_hash,                -- 选中文本 SHA-1（指纹校验）
    raw_context,              -- 前后缀上下文（回退定位 + 显示）
    question, answer, status, -- active | outdated | resolved
    parent_id,                -- 批注的批注（邻接表，替代 JSON 嵌套）
    created_at
  )
  ```
- 与正文解耦：**高亮是渲染层装饰**，不改内容（y-comments 哲学：正文保持纯内容）

**③ 解析链（降级顺序，歧义即放弃、永不删除）**

```
① 精确命中：block_id 找到 → 按 [start, end) 定位 → 校验 text_hash 与当前块文本一致 → 命中
② 引文回退：hash 不一致（块内容变了）→ selected_text + raw_context 做块内/全文引文搜索 → 命中
③ 兜底：仍找不到 → 标记 status = 'outdated'（侧栏显示引文，附"内容已变更"）→ 线程永不删除
```

**④ 流式期间的稳定性**
- 渲染改为**增量**：块内容变化只更新该块（不再整个 message-body 重建）
- 锚基于 block_id（稳定），流式期间创建的批注不因重排丢失

### 4.3 与业界方案的映射（面试讲"为什么这么设计"）

| 设计 | 对应业界 | 来源 |
|---|---|---|
| block_id + 偏移 + 指纹 | y-comments 的容器 id + RelativePosition + quote | 已核实源码 |
| text_hash 校验 | "模糊匹配视为未命中，绝不猜" | y-comments README |
| outdated 兜底 | GitHub outdated review comment / deditor detached | 行为一致（多家交叉印证） |
| 外置注释表 + parent_id | ThreadStore / CommentStore（独立于正文） | deditor/Lexical 已核实 |
| 高亮为渲染装饰 | "评论不进文档，decoration 只读覆盖层" | y-comments 论证"为何不用 mark" |
| 批注嵌套改邻接表 | 对话树项目的 parentId 共识 | stello/Prompt-Tree/LibreChat |

### 4.4 迁移路径（渐进式）

1. **阶段 1（结构就位）**：建 annotations 表 + 内容块化渲染 + 创建流程写入新表（旧 JSON 只读兼容）
2. **阶段 2（锚定闭环）**：解析链（精确→引文→outdated）+ 文本指纹校验
3. **阶段 3（体验）**：增量渲染（流式不丢高亮）+ 批注的批注改邻接表
4. **阶段 4（清理）**：删除旧 annotations JSON 写入路径，全量迁移

### 4.5 批注回答链路：元消息标记与上下文隔离

**问题**：当前批注追问走正常对话通道（`createChatStream(conversationId, 拼装消息, ...)`），拼装消息与回答会持久化进消息历史——**批注（支线）污染了主线对话上下文**：主线 AI 开始引用支线内容；批注回答存库但与批注卡片显示不一致；批注回答无法独立管理。

**核心原则**：批注是"对已有回答的元讨论"，是旁路（out-of-band）——**复用流式通道与工具能力，但不进入主线上下文**（类比：stello 的 `insight` 一次性注入槽、y-comments 的"评论外置"）。

**① 消息加 `kind` 字段（元消息标记）**

```sql
messages (
  ...,
  kind TEXT DEFAULT 'chat',   -- 'chat' 正常对话 | 'annotation' 批注回答
  annotation_id TEXT,         -- 非空 = 该条消息是某批注的回答（审计/回放用）
  created_at ...
)
```

**② 上下文构建过滤**：`buildContext(conversationId)` 只取 `kind = 'chat'` 的消息——批注回答存库、可审计、可回放，但**主线 AI 永远看不见它**。

**③ 批注回答完整链路**

```
选中文字 → 创建 annotation（锚定层）→ 输入追问
   ↓
POST /api/annotations/:id/reply（复用流式基础设施：SSE/分片/工具/并发锁/错误处理）
   ↓
上下文构造：
  system: "你是批注问答助手。用户对之前回答中的一段文字发起追问，
           只回答该引用相关的内容，不展开其他话题。"
  context: 被批注的完整回答或所在块（引用语义完整性，当前实现只给引文字符串的缺陷所在）
         + 前后段落（消歧）
         + 主线历史（只读，截至被批注消息）
  user:   "【引用】{selectedText}\n【追问】{question}"
   ↓
流式写入 annotations.answer → 渲染进批注卡片
   ↓
对批注的再追问 → parent_id 邻接表挂链 → 上下文携带前序问答链（子线程）
```

**④ 设计决策与理由**

| 决策 | 理由 |
|---|---|
| 复用流式通道，不建独立协议 | SSE/分片/工具/错误处理/并发锁全部复用；批注回答与正常回答共用同一质量管线（评测、日志） |
| 元消息标记而非完全独立存储 | 独立存储需重写全套流式链路（重复造轮子）；标记方案 = 一个字段 + 一个过滤条件 |
| 上下文隔离 | 支线不污染主线——"批注式对话"与"把追问塞进对话"的本质区别 |
| 结构化上下文（【引用】/【追问】） | 显式区分"引用内容"与"指令"，优于自然语言拼装 |
| 给完整原回答而非仅引文 | "数据来源不可靠"单独无语义，完整回答让模型正确理解追问语境（当前实现的最大不友好点） |

**⑤ 与 Agent 化的衔接**：批注回答本身是一次 Agent 任务——纳入决策日志（trace_id）与评测集（新增"批注回答质量"维度：是否针对引用、是否跑题、是否正确——绝大多数评测集不会覆盖的维度，因为很少有人做过批注式交互）。

---

## 五、验证设计（每个升级的测量仪）

| 升级点 | 验证方式 |
|---|---|
| 批注锚定链 | ① 单元：锚定解析（精确/引文/outdated 三级）② **突变测试**：改/删/重排块内容，断言批注正确降级③ 回归：现有 106 项全绿 |
| 批注回答隔离 | ① 上下文构造只含 `kind='chat'` 消息② 批注回答后主线对话行为不变（回归）③ 元消息审计可查（annotation_id 回链） |
| 事件流与回溯 | ① 事件只追加不改写（写入路径强制）② `renderUpTo(seq)` 与全量渲染结果一致（重放等价性）③ 分叉后原线不变量（原线重放结果不受分叉影响）④ 回退语义（截断后重放停在回退点） |
| 块化渲染 | 渲染快照测试：同一内容渲染结果稳定；块 id 稳定（内容不变 id 不变） |
| Agent 编排 | 决策日志可注入 mock；回放测试（记录→重跑→断言一致） |
| 评测框架 | 任务评测集（完成率/效率/正确率/一致性四指标） |
| 上下文分节 | ① 每节独立替换（只换任一节，其余节输出逐字节不变）② 预算不超限（按节 maxTokens 截断）③ 压缩后信息保留度（关键事实仍可检索）④ 焦点优先级（【引用】信息完整度优先于【历史】截断） |
| MCP/安全 | 协议 schema 校验；DNS 校验、沙箱超时、注入攻击回归 |

---

## 六、边界与不做清单

- 不做 CRDT 协作（无多人实时协作需求；RelativePosition 用不上，以 block_id + 偏移替代稳定锚）
- 不接真实 AI/Embedding provider（保持 mock 验证；接真实服务为独立任务）
- 不做多租户/部署横向扩展（量级不需要）
- 幂等迁移、旧数据兼容在阶段 1 就位（不影响现有用户）

---

## 七、简历叙事（升级完成后）

> **可验证的 Agent 编排系统**：规划-执行-反思闭环 + 事件流（唯一事实源）与全链路回放 + 四维行为评测（完成率/效率/正确率/一致性）+ 对抗评测；核心交互"文本选区批注"重构为**分级锚定链**（块锚 + 文本指纹 + 引文回退 + Outdated 兜底），对齐富文本编辑器生态的标准做法（y-comments/Lexical），解决流式内容下批注漂移与静默丢失问题；对话可**回溯与分叉**——查看任意时刻、从任意点另起新线（参考 deepseek-harness 的事件日志、stello/Claude Code 的分叉语义），批注、回溯、分叉统一为"过去可寻址"的三种呈现。

**面试一句话**：市面项目做 Agent 是"能跑"，我做的升级是"**可证明**"——批注挂载从"内容搜索"升级为"锚定链"，Agent 从"黑盒"升级为"全链路可回放"，对话从"线性记录"升级为"任意时刻可回溯、可分叉、可批注"的时光机。
---

## 八、从项目到工具：演进路线（对标 deepseek-harness）

### 8.1 目标定义：从"应用"到"框架/工具"

**差距的本质是"用户是谁"**：dsh 是给**开发者**用的框架（`npm install` → 写代码 → 跑起来）；当前 ThreadThink 是给**使用者**用的应用（部署 → 登录 → 聊天）。"变成好用的工具" = 让会写代码的人**直接用、能定制、可扩展**。

| 维度 | 当前（应用） | dsh（框架） | 差距 |
|---|---|---|---|
| 形态 | 单一 Web 应用 | CLI + SDK + 多形态 | ❌ 无 CLI/SDK 入口 |
| 配置 | 写死在代码 | profile 命名组合 + patch 叠加 | ❌ 不可配置 |
| 扩展 | 四类工具 | 一切皆插件（注册即插拔） | ❌ 协议不完整 |
| 开发者体验 | README + 测试 | 完整文档体系 + 测试基座 + 示例 | ❌ 无入门/指南/示例 |
| 工程质量 | 双协议硬编码 | 适配层 + 结构化终止原因 + 版本迁移链 | ⚠️ 部分有设计未实现 |
| 生态 | 无 | 插件市场 + 多端客户端 | ⚠️ 远期，不做 |

### 8.2 第一层：工具化（决定"是不是工具"，必做）

**① CLI + SDK 双形态（工具入口，最关键的差距）**

```bash
# CLI：命令行直接对话
tt chat "解释一下 RAG"
tt tools list                     # 查看已注册工具
tt session status                 # 会话状态
tt plugin install <pkg>           # （第三层生态，先留接口）

# SDK：编程接口（核心价值——嵌入他人工作流）
import { ThreadThink } from 'threadthink';
const app = new ThreadThink({
  provider: 'openai-compatible',   // 可插拔
  tools: [myCustomTool],           // 自定义工具
  rag: { chunkSize: 1000 },        // RAG 参数
});
const reply = await app.chat('问题', { context: ... });
```

- 设计要点：CLI 与 SDK 共享同一 `core`（Fastify 服务只是 core 的一种宿主）；headless 模式（无 Web UI 也有完整能力）

**② 配置化 + Provider 适配层（从"写死"到"可配置"）**

- `threadthink.config.json`：模型提供商、工具开关、RAG 分块参数、persona、上下文预算
- **Provider 适配层**：当前 `if (model.includes('deepseek')) ... else if (anthropic)` 硬编码 → 改为**可插拔 adapter 接口**：

```ts
interface ProviderAdapter {
  chat(messages, options): Stream;   // 流式对话
  embed?(texts): Promise<number[][]>; // 向量化（可选）
  supports(provider: string): boolean;
}
// 内建：openai-compatible / anthropic / mock（测试用）；第三方可实现后注册
```

- 为什么：双协议 if/else 每加一个提供商改一次核心——适配层让"加提供商 = 加一个 adapter"

**③ 插件协议完整化（"Everything is a Plugin" 的落地）**

- 工具协议升级为**输出契约三件套**（参考 dsh 的 `output.schema/render/presentationMeta`）：

```ts
registerTool({
  name: 'doc_search',
  parameters: { query: { type: 'string' } },        // ① 模型看到的（参数校验）
  output: {
    schema: { type: 'object' },                      // ② 返回值规范化校验
    render: (args, value) => `检索结果：${...}`,      // ③ 模型看到什么（与②分离）
    presentationMeta: (args, value) => ({...}),      // ④ UI 卡片（可重放，重放不重跑工具）
  },
  execute: async (args, { signal }) => {...},
  dispose: () => {...},                              // 注册即回卷：卸载时反注册（轻量版，不需要 Cordis）
})
```

- **外部插件加载**：约定 `tools/` 目录（每个子目录一个插件：`manifest + index.js`）或 npm 包入口——第三方"写一个包、放一个目录"即可挂载，无需改核心
- 与 design.md 3.3（可观测层）的关系：工具调用的 `tool/result` 同时是事件流的一个节点（trace 与回放免费获得）

### 8.3 第二层：开发者体验 DX（"用得舒服"，做了加分）

- **文档**：Getting Started（10 分钟跑通）/ 插件开发指南（加一个自定义工具全流程）/ API 参考
- **示例集 `examples/`**：最小可用示例各一——自定义工具、自定义 provider、RAG 用法、批注用法（示例 = 最有效的文档）
- **类型定义**：SDK 提供 `.d.ts`（或 JSDoc 注释生成）——纯 JS 对使用者不友好
- **测试基座**：现有 mock 模式（stub fetch / mock provider）提炼为测试辅助包（`threadthink-testkit`）：`mockProvider()` / `mockTool()`——第三方写插件时可直接用它自测（对应 dsh 的 `llm-mock-server`/`tool-testkit` 的轻量版）

### 8.4 明确不做（边界）

- 插件市场 / 插件管理器（pnpm 安装第三方插件、版本管理）——20 个用户前不需要
- 遥测 / 匿名用户标识 / OTel 导出器
- 多端（Electron/Web/SDK/ACP 同构）、HMR、双语文档管线、事件矩阵生成
- Cordis 式插件框架本体（Service 类/注入声明合并/五模式事件）——注册表 + dispose 语义足够

### 8.5 演进顺序（里程碑，每阶段 106 项测试全绿是底线）

| 里程碑 | 内容 | 投入 | 产出（别人能做什么） |
|---|---|---|---|
| **M1 工具化骨架** | CLI + `core` 抽离 + 配置化 + provider 适配层 | 1 周 | 别人能 `tt chat` 对话、改配置换模型 |
| **M2 插件协议** | 输出契约三件套 + 外部插件加载 + 插件开发指南 | 1 周 | 别人能"加一个工具"不经核心 |
| **M3 开发者体验** | examples + 类型定义 + 入门文档 + testkit | 1 周 | 别人 10 分钟跑通、写插件有测试基座 |
| （第三层）生态 | 插件市场/多端——**明确不做**，接口预留即可 | — | — |

### 8.6 与现有设计的关系（演进不是重来）

- 输出契约三件套 = 3.3 可观测层"工具调用事件流"的**输入约定**（工具先定契约，事件流才有完整记录）
- provider 适配层 = 3.6 MCP 兼容的**实现基础**（MCP 只是 adapter 的一种）
- 配置化 = 3.5 上下文分节的**参数来源**（分节配置、预算上限都从 config 读）
- CLI/SDK = 3.7 事件流的**消费形态**（`tt session status` 就是读事件的派生视图）
- **一句话：演进不是推倒重来，是把第三～七章的设计"加一个入口、一份配置、一条协议"，让它从"被使用的应用"变成"被扩展的工具"**
