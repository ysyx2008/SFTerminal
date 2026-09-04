# History Service SPEC

> Last verified: 2026-08-27（超大工具输出点开不硬渲染）

## 设计目标

### 粘贴进对话的图跟历史一起留着（2026-08-27）

- **问题**：贴进来的图如果放进给秘书干活的临时工作区，过几天会被清掉，历史对话里的路径就断了。
- **成功标准**：粘贴图跟对话历史一起长期保存；不进临时工作区，也不按临时区那套过期。过几天回头看，图还在。
- **关键取舍**：这是对话材料，不是草稿。
- **明确不做**：不另做相册；删对话时是否立刻清掉对应图，这次不另立规矩。

### 新对话何时进历史

用户发出第一条消息后，这条对话就进入历史列表；不必等第一次任务跑完。只点了新对话、还没说话，不进历史。任务进行中持续记下进度，崩溃后能从已写下的部分恢复。

### 最近对话列表也能全文搜（2026-08-17）

- **问题**：侧栏搜索只看标题，正文里说过的话找不到。
- **成功标准**：和历史弹窗一样——边打只筛标题，回车或点搜索才扫对话正文（用户消息、追加、主动找人、最终结果）。从最新往最旧扫，命中一条就立刻出现在列表里，不用等全部搜完。换词、关搜索或再搜一次，必须停掉上一次扫描，不能叠着扫。
- **关键取舍**：不边打边扫全文，避免历史一多就卡。
- **明确不做**：不搜 AI 回复和工具输出；不上新的全文索引；暂不做进度条和手动中止按钮。

### 全文搜索要能搜到附件标题（2026-08-26）

- **问题**：用户发过的文件名只挂在那条消息的附件信息上，不在打字正文里。全文搜索只扫用户打的字，搜文件名就找不到那条对话。
- **成功标准**：回车全文搜索时，用户消息和追加消息上的附件标题也算命中。边打只筛会话标题的行为不变。
- **明确不做**：不搜 AI 回复和工具输出里的文件名；不把附件标题写进会话标题索引。

### 存一条记录的代价，不该跟着历史总量一起涨（2026-08-22）

- **问题**：会话清单原先是一整份名录，每存一条记录都要把整份重抄一遍。任务执行中每走一步都会存一次，于是历史越长，每一步越卡——实测三万多条时单次要停顿数十毫秒，一个二十步的任务光这件事就白扔掉一秒多，界面掉帧、终端打字发涩。更糟的是它只会越来越慢，且正因为读写不起，我们一直在靠"只留最近多少条""标题截断到多少字"这类有损办法压规模。
- **成功标准**：
  1. 存一条记录的开销跟历史里已经有多少条**无关**——不会因为用得久了就变慢。
  2. 桌面和命令行同时在用时，谁写的记录都不会被对方抹掉。
  3. 写到一半断电或崩溃，已经存下的部分照样读得出来，重启后能接着往下写。
  4. 清单坏了或丢了，能从对话正文重新数出来——正文才是真相源，清单只是为了不必每次翻遍所有对话。这一点在"先写后读"的顺序下同样成立：不能因为程序上来就存了一条新记录，就把之前的历史当成不存在。
  5. 用户这边看不出任何差别：列表、搜索、删除、统计都照旧。
- **关键取舍**：清单是可以重新数出来的派生数据，所以宁可极小概率重建一次，也不给"每存一条"这条最热的路加锁——那是每走一步都要付的钱，而重建是几年一遇。
- **明确不做**：不为此引入数据库（要带原生组件，多平台打包和杀毒软件的风险比这件事本身大得多）；不动对话正文的存法；现有那些截断上限暂时留着，等这条路稳定跑一段再单独议。

### 整场可以大，单条工具输出不能拖死窗口（2026-08-16，2026-08-27 修订）

复杂任务本来就会产出很长的历史（比如反复改一篇长文，每一步都留下完整快照）。整场保存，不在写入时截断整场。

但单条工具输出如果大到会拖死窗口（几百万字、几百兆，甚至几乎全是空字节），点开时不能整段灌进界面。列表只拉标题；点开先出能看的步骤；超大的那一步只给大小、开头、结尾，真要看完整内容就另存成文件用别的工具打开。不在聊天里做成逐行翻几千万字的编辑器。

读盘时按行跳过超大的那一行，不要因为一行太大就把整场扔掉——前面的步骤往往还有用。

翻历史时不能把整份大记录一次性倒进内存，更不能同时翻很多份。搜索只看匹配需要的内容，产出物快照先跳过。

语义搜索已经知道是哪一条对话时，直接打开那一条，不要再把全部历史翻一遍。

## 职责

历史数据的运维聚合服务。组合 `AgentRecordStore`（会话记录存储聚合，见下），并保留以下非会话域职责：
- 聊天记录（ChatRecord，遗留）
- Token 用量统计（跨主树 + watch 树的索引聚合）
- 清理 + 存储统计

> 完整数据备份/恢复已迁至 `electron/utils/data-backup.ts` + `bootstrap.ts`（整包 userData），不再由本服务提供选择性导出/导入。

**会话记录存储已下沉到 `AgentRecordStore`**（`history/agent-record-store.ts`）：拥有 agent/watch 两棵历史树 + 索引机器 + 步骤内联图片外化 + main/watch 路由。`HistoryService` 的 AgentRecord 相关公开方法（`saveAgentRecord` 等）保留为**委派转发**，向后兼容现有调用方（main.ts IPC / AgentService / Agent / 前端）；读侧新代码应走 `ConversationManager` → `ConversationStore` → `AgentRecordStore` 接缝（见 `conversation/`）。

**双历史树**：用户/联络/终端任务记录存 `history/agent/`（主索引 `agent-index.jsonl`）；watch（关切）的「内心独白」执行记录存 `history/watch/`（独立索引 `watch-index.jsonl`）。两者**物理隔离**，避免高频内心独白（曾占主索引 93%、把它压到 ~149MB）压舱主索引、拖慢每次写盘。归属由 `AgentRecord.agentKey === '__watch__'` 结构化判定（不再用 userTask 关键词匹配）。

## 文件

- `electron/services/history.service.ts`：ChatRecord + Token 统计 + 清理；组合 `AgentRecordStore` 并委派会话记录方法。
- `electron/services/history/agent-record-store.ts`：`AgentRecordStore`——会话记录存储聚合（CRUD + 索引机器 + 图片外化 + canvas 剥离 + main/watch 路由），`ConversationStore` 的真相源。
- `electron/services/history/agent-storage.ts`：会话记录文件 IO 纯函数（读/写/列举/损坏隔离；含旧单体 `.json` 兼容）。
- `electron/services/history/session-persistence.ts`：增量会话持久化（`meta.json` + `steps.jsonl` / `messages.jsonl`）。
- `electron/services/history/date-util.ts`：`getDateString()` 纯函数，供 store 与 service 共用。

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `saveChatRecord(record: ChatRecord): void` | 保存一条聊天记录（**已废弃**，无调用方） | 仅导入流程 |
| `saveChatRecords(records: ChatRecord[]): void` | 批量保存聊天记录（**已废弃**） | 导入流程 |
| `getChatRecords(startDate?, endDate?): ChatRecord[]` | 按日期范围查询聊天记录（**已废弃**） | 导出流程 |
| `rebuildAgentIndex(): void` | 从磁盘重建**全部**索引（主 agent + watch 两套） | v5/v6 迁移、清理后、维护 |
| `saveAgentRecord(record: AgentRecord): void` | 保存 Agent 执行记录并更新索引；按 `agentKey` 路由到 agent 或 watch 树/索引 | `agent/index.ts` |
| `saveArtifacts(recordId: string, artifacts: CanvasArtifact[]): void` | 保存（或更新）产出物面板清单到指定记录；自动剥离 `contentFromFile` 的 content（可从磁盘重生） | IPC `history:saveArtifacts` |
| `getAgentRecords(startDate?, endDate?): AgentRecord[]` | 按日期范围查询 Agent 记录（主树 + watch 树） | 前端历史面板、导出 |
| `getAgentRecordById(id: string): AgentRecord \| undefined` | 按 ID 精确查找 Agent 记录 | 回放/详情查看 |
| `deleteAgentRecord(id: string): boolean` | 按 ID 删除单条 Agent 记录（日文件、索引、关联截图目录） | IPC `history:deleteAgentRecord`、最近对话侧栏删除 |
| `getRecentAgentRecords(limit?, filter?): AgentRecord[]` | 获取最近的 Agent 记录（**主索引**，不含 watch；支持自定义过滤） | `agent/index.ts`、上下文构建 |
| `getRecentWatchRecords(limit?, filter?): AgentRecord[]` | 获取最近的 watch 执行记录（**watch 索引/树**，供关切审计） | 审计 / 统计 |
| `listAgentHistorySummaries(excludeWakeup?): AgentHistorySummary[]` | 从索引列出全部摘要（首条 user_task 作标题，不读日文件） | IPC `history:listAgentSummaries`、`AiPanel` 历史弹窗（无搜索词时的列表） |
| `searchAgentRecords(keyword: string, limit?): Promise<AgentRecord[]>` | 关键词搜索 Agent 记录（`searchAgentRecordsAdvanced` 的薄封装） | 工具/记忆检索 |
| `searchAgentRecordsAdvanced(options): Promise<SearchAgentRecordsResult>` | 高级搜索：`userTask`、`finalResult`、`user_task`/`user_supplement` 步骤等；`titleOnly` 仅匹配标题 | IPC `history:searchAgentRecords`、`AiPanel` 历史弹窗在用户按回车/点搜索触发全文检索时 |
| `getTokenUsageStats(): TokenUsageStatsResult` | 返回 Token 用量统计 | 设置 UI |
| `getDataPath(): string` | 返回数据目录路径 | `cli/index.ts` 信息展示 |
| `getHistoryPath(): string` | 返回历史记录目录路径 | `cli/index.ts` |
| `getAgentRecordStore(): AgentRecordStore` | 暴露会话存储聚合，供 `ConversationManager`/`ConversationStore` 装配为读侧接缝 | `agent/index.ts` 装配 |
| `cleanupOldRecords(daysToKeep?): {chatDeleted, agentDeleted}` | 清理过期记录 | 维护任务 |
| `getStorageStats(): {chatFiles, agentFiles, agentSessions, totalSize}` | 返回存储统计信息（含 watch 树）；`agentFiles` = 有记录的天数；`agentSessions` = 主+watch 索引会话总数 | 设置 UI |

## 核心类型 / 接口

### ChatRecord（@shared 共享类型）
`{ id: string, role: "user"|"assistant", content: string, timestamp: number }`

### AgentRecord（@shared 共享类型）
含 `id`、`sessionId`、`timestamp`、`summary`、`tokenUsage` 等完整执行信息。

### AgentIndexEntry（`history/agent-record-store.ts` 导出）
`{ id, timestamp, duration, dateStr, userTask, terminalType, agentKey?, sshHost?, status, tokenUsage? }`，常驻内存，用于排序/过滤/搜索时避免读取完整日期文件。

### AgentRecordStore（`history/agent-record-store.ts`）
会话记录存储聚合。构造接收 `historyDir`，自建 `agent/`/`watch/`/`images/` 目录。公开：会话 CRUD（`saveAgentRecord`/`getAgentRecordById`/`deleteAgentRecord`/`getAgentRecords`）、最近/按 agentKey/watch 查询、`listAgentHistorySummaries`、`searchAgentRecords(Advanced)`、`rebuildAgentIndex`、`cleanupOldAgentRecords`、索引读侧暴露（`getMainIndex`/`getWatchIndex`/`getAllIndexEntries`，供 Token 统计/存储统计复用）、`getStorageStatsForBoth`/`totalSessionCount`。内部按 store 参数化索引方法（正文目录 + 索引日志 + 可选的 userTask 截断长度）。

## 依赖（跨 service）

无跨 service 依赖。纯文件 I/O，不依赖其他 service。

## 关键行为 / 数据流

**Agent 存储机制**（v5 起；增量目录格式为现行写入路径）：
- **现行写入**：`history/agent/YYYY-MM-DD/{sessionId}/` 目录
  - `meta.json`：身份、标题、状态、token、watermark（`stepCount` / `messageCount`）
  - `steps.jsonl` / `messages.jsonl`：追加写 transcript
- **checkpoint**：只追加新增 steps/messages；条数未变时只改 `meta.json`（状态/token/时长等）
- **标题**：`updateTitle` 只改 `meta.json`（目录尚未创建时进 pending，首次 save 并入）
- **兼容读**：仍可读旧单体 `history/agent/YYYY-MM-DD/{sessionId}.json`；下次 `save` 迁入目录并删除单体文件
- meta / 全量 jsonl 写入使用原子 rename（`electron/utils/atomic-write.ts`）；损坏单文件隔离为 `.corrupt.{timestamp}`
- v5 迁移将旧 `agent/YYYY-MM-DD.json` 数组拆分为单文件，旧文件改名为 `.json.migrated` 保留 30 天
- 图片外化等**原地改写**步骤内容时走 `forceRewrite` 全量重写 jsonl（不能 append）

**Watch 历史隔离机制**（v6 起）：
- watch 内心独白记录（`agentKey === '__watch__'`）存到**独立树** `history/watch/YYYY-MM-DD/{sessionId}/`（与 agent 树相同的增量目录格式；旧单体 `.json` 仍可读），正文与 agent 树一致、按日期拆分、可长期审计
- 维护独立索引 `watch-index.jsonl`；其条目 userTask 截断到 200 字（心跳模板展开后很长，索引只用作审计标题，正文完整保存在日文件里）
- `saveAgentRecord` 用 `storeForRecord()` 按 agentKey 路由；`readAgentRecordFromDisk` / `getAgentRecordById` 先查 agent 树再查 watch 树，by-id 查找两树通吃
- v6 迁移把 agent 树里属于 watch 的正文 **rename**（仅改目录、不读写内容、正文逐字节不变）到 watch 树。旧记录（agentKey 字段引入前、无结构化标记）靠 userTask 心跳前缀识别，该启发式**仅迁移期一次性使用**，运行时一律 agentKey 结构化判定
- **设计动机**：watch 高频写入曾让单一 agent-index 膨胀到 149MB（2.6w 条占 93%）、每次写盘全量重写（O(N)）。隔离后主索引只剩真实任务、瘦回几 MB；watch 成本仍由 `getTokenUsageStats` 合并两索引计入，不漏算

**Chat 存储**（遗留）：`history/chat/YYYY-MM-DD.json`，当前无写入方，仅导出/导入兼容。

**索引机制**：每棵历史树各维护一份索引，落盘为**只在尾部增长的追加日志**（`agent-index.jsonl` / `watch-index.jsonl`）——存一条就追加一行，同一会话后写的胜出，删除写一条墓碑；冗余积累到一定程度再压实成紧凑形式。读侧记住已消费到的字节位置，之后只读新增部分。旧版单个 JSON 数组的索引在首次访问时自动转换、原文件留档。索引缺失或读不出来时从正文重建，**读写两条路径都要过这一关**（只在读路径兜底的话，一次"先写后读"会拿新记录建出只含它自己的索引）。`getRecentAgentRecords` / `listAgentHistorySummaries` / `searchAgentRecordsAdvanced` 仅以**主索引**为候选来源（天然排除 watch）；`getTokenUsageStats` 合并主 + watch 两索引（watch 也耗 token，须计入）。

**多进程索引安全**（CLI 与桌面共用 userData）：
- **写侧**：追加只动自己那一行，天然不会覆盖他进程刚写的条目，因此不需要"写前把整份索引读回来合并"。
- **读侧**：日志首行带一个身份标记。压实会用新文件整个换掉旧文件，"只在尾部增长"的前提随之失效，读到的字节位置就可能落在行中间——发现身份变了就整份重读。判定与读取全程用同一个已打开的文件句柄，避免两者之间的缝隙里恰好发生压实。
- **压实**：跨进程互斥，抢不到就跳过（晚一轮没有影响）。换文件那一瞬间，另一进程正要追加的那一行有极小概率落空；索引可从正文重建，故接受，换来的是追加路径完全不必加锁。
- **读正文**：`getAgentRecordById` 索引命中但正文不在 `dateStr` 时回退全盘扫描（不再直接 `undefined`）；删除时若 `dateStr` 错位也会扫日期目录清孤儿正文。

**搜索性能（searchAgentRecordsAdvanced，async）**：先用内存索引按「时间窗 + filter（cast 到索引条目，与 `getRecentAgentRecords` 同款）」筛候选，`titleOnly` 时关键字匹配也在索引层完成。
- `titleOnly`：候选即命中集，仅为前 `limit` 条读回完整记录，零全量扫描；
- full：关键字可能命中 `finalResult`/steps 正文，须读完整记录二次匹配，但仅读候选所在日期文件，且逐文件 `await`（`fs.promises`）让出事件循环，避免历史量大时同步遍历阻塞主进程导致界面冻结。
- 读正文按行进行，检索场景不装入产出物快照；点开先出能看的步骤，超大的单条输出不整段读回。
- 被取消的搜索立刻停，不必扫完，也不再承诺总命中数；未取消时仍扫完全部候选再报总数。
- 历史规模极大时的根治方案是迁移至 SQLite + FTS（当前未做）。

**完整备份/恢复**：见 `electron/utils/data-backup.ts` / `bootstrap.ts`（整包 `userData` 为 `.zip`，不在本服务内）。

## 关键约束

- **记录一旦保存不得修改历史内容**——只能追加，不能覆写（审计完整性）
- **翻历史必须有界**——不能把整份大记录一次性倒进内存，也不能同时翻很多份；搜索时跳过产出物快照；点开先出能看的步骤，超大的单条输出不整段进界面
- **Agent 记录 ID 必须全局唯一**（UUID v4）
- **数据文件编码必须为 UTF-8**
- **`cleanupOldRecords` 默认保留 90 天**，调用方不得传入小于 7 天的值
