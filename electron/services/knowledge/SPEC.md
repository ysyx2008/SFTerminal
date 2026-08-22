# Knowledge Service SPEC

> Last verified: 2026-08-19

## 设计目标

### 不向用户开放 MCP 知识库接入（2026-08-13）

- **问题**：设置里曾有「MCP 知识库服务」，看起来能接外部知识库，但协同搜索并未做完——开了也搜不到，失败还没有提示。
- **成功标准**：记忆与知识库设置不再展示该入口；即使用户以前选过某台 MCP，搜索也只走本地知识库。
- **明确不做**：本次不实现外部 MCP 知识库。

### utilityProcess 隔离 + 桌面端禁止静默回退主进程（2026-07-23）

- **问题**：Embedding / LanceDB 设计进 utilityProcess；打包 `asarUnpack` 缺传递依赖时 worker ESM 失败，旧逻辑 `warn` 后回退主进程——功能「看似能用」，Windows 上堵 UI，测试也发现不了。
- **成功标准**：
  - worker 所需依赖必须在 `asarUnpack` 物理目录，ESM `import()` / `require` 可解析。清单至少覆盖：`onnxruntime-common`、`apache-arrow`、`@huggingface/jinja`、`@huggingface/tokenizers`、以及 `transformers→sharp` 的 `detect-libc` / `@img/colour` / `semver`、`lancedb` 的 `reflect-metadata`、`apache-arrow` 的 `tslib` / `flatbuffers`。unpacked 包无法再解析仍在 asar 内的依赖。
  - **预防**：`npm run check:asar-unpack`（静态对照 yml）纳入 `npm run verify`；`afterPack` 对真实 `app.asar.unpacked` 再跑一遍，缺口则构建失败。
  - **桌面端（utilityProcess 可用）**：worker 初始化失败 → **直接失败**（error 日志 + 知识库不可用状态），**禁止**再 load 进主进程。
  - **唯一例外**：CLI / shim 下 `utilityProcess.fork` 不可用时走进程内模式（无 UI、也无 worker 可选）——这不是「失败后降级」。
- **明确不做**：不在 worker 失败后再偷偷 in-process「救活」；不靠关键词解析错误串做分类。

### 向量库 worker 掉了要能自愈，不能静默变空（2026-08-16）

- **问题**：向量库 worker 崩溃或被系统回收后，应用仍认为自己「已初始化完成」，之后所有读写都落到没有数据库连接的进程内分支上——写操作报错、检索返回空。用户看到的是「记忆突然什么都搜不到了」，没有任何提示，只能重启应用才恢复。
- **成功标准**：
  - worker 掉了以后，下一次读写会自动把它重新拉起来并恢复正常，用户不必重启应用。
  - 重新拉起失败时明确报错：不能悄悄返回空结果冒充「没搜到」，也不能偷偷改用主进程加载向量库（这是既有约束，此处一并守住）。
  - 多路操作同时发现 worker 不在时只重建一次，且重建不留下孤儿进程。
  - 清空知识库不需要先把 worker 拉回来——用户来清库往往正是因为库坏了、起不来。
- **明确不做**：不做后台定时探活（按需重建足够）；不因一次重建失败就永久停用向量库——用户可能只是一时资源不足。

### worker 重启不得留下孤儿进程（2026-08-16）

- **问题**：11.6.0 用户现场一天内嵌入 worker 被拉起 89 次、只退出 6 次——83 个 worker 还活着却已无人管理，每个占 100–250MB，整个应用的进程组内存冲到 16GB，最终主进程内存耗尽崩溃。多路记忆召回并发触发重启时会互相打断：上一代 worker 的死亡通知把新一代的初始化握手判成失败，于是「重启失败 → 再重启」越滚越多（当天 45 次重启失败、101 次请求被中断），而定期重启本身只发生 6 次，并非主因。
- **成功标准**：
  - 任一时刻只有一个在用的嵌入 worker；被替换掉的 worker 必须真正退出，不允许出现「活着但没人管、也杀不掉」的进程。
  - 上一代 worker 的退出或被杀，不得影响新一代 worker 的初始化握手和它正在处理的请求。
  - 多路召回同时要求重启时共享同一次重启，不各自拉起进程、不互相杀死对方刚建好的 worker。
  - 重启过程中不得让调用方误以为「本机不在 worker 模式」而走到没有加载模型的进程内推理上。
  - 长时间运行（跨天、多轮定期重启）后进程数与内存回到基线，不随运行时长单调增长。
- **明确不做**：不用「进程数超限就杀最老的」这类兜底来掩盖泄漏；不因此取消定期重启——它是抑制推理内存池膨胀的必要手段。

### 救不回来的时候，别把磁盘吃掉（2026-08-22）

- **问题**：知识库坏了以后，每次启动都会把手上的备份从新到旧挨个试一遍。每试一份，就把当前这份整个改名留下来当"现场"，一份两三百兆。用户有三份备份，于是每启动一次就多留三份、七百兆，且从来没人清。开发调试期间频繁重启，三天堆出一百四十多份，数据目录被撑到 55 G（其中 42 G 全是这些现场）。而这三份里只有第一份是真的——后两份是刚从备份复制进去、又被判定读不开的副本，内容和备份本身一模一样。更浪费的是"这批备份都救不回来"这个结论已经是确定的，却每次启动都要用几百兆的复制重新验证一遍。
- **成功标准**：
  - 一次启动最多留下一份现场，且是用户数据真正坏掉的那个样子；同一轮里试更早备份时被换下来的副本不留
  - 现场有数量上限，超出的自动清掉最旧的——占用不随重启次数增长
  - 同一批备份试过一遍都救不回来，下次启动不再重来，直到备份有更新或用户手动发起恢复
  - 现场集中放在一处，用户一眼能看出它占了多少、能整个清掉
- **关键取舍**：现场是留给排查的，不是存档。真要排查，最近一份就够用，更早的那些内容雷同；宁可少留，也不能让"将来也许用得上"把用户磁盘吃光。
- **明确不做**：不因为救不回来就清库重建（守住上一条已定的约束）；不自动删用户的备份。

### 坏了不要把坏的存成最新备份，更不要整库推倒（2026-08-19）

- **问题**：检索发现向量文件缺了一块，会标成损坏。下次启动本应先回到上一份好备份，只补缺的几篇。实际却先把当前这份坏的存成最新备份，再按它恢复；读不开就把整张向量表丢掉，九千多篇从头建。好备份被轮替掉后，热重载会连着全量重建。
- **成功标准**：
  - 已经标了损坏时，这次启动不再自动备份
  - 恢复后如果还是读不开，从新到旧试更早的备份；都读不开也不要整表丢掉，也不要因此全量重建
  - 自动备份只在没有损坏标记时做（启动时磁盘还没被这次进程打开，复制是安全的）
- **明确不做**：这次不改「检索时怎么判断文件缺了」；不在退出时做同步备份（会拖慢关掉窗口）。

### 初始化失败熔断（2026-07-27）

- **问题**：11.4.1 禁止回退后，Agent 每次 L2/L3 召回仍会 `initialize()`；打包缺依赖时反复 fork Embedding worker，日志上千条「退出 code=0」，拖垮资源并放大「未响应 / 终端黑屏」。
- **成功标准**：
  - Embedding / Knowledge 任一侧初始化一旦完整失败，**闩锁**该错误：后续 `initialize` / `search` / `embed` 直接抛出同一错误，**不再 spawn worker**。
  - 用户显式换设备（`setDevice`）、`dispose` / 备份恢复后再允许重试——不是靠解析错误文案分类。
- **明确不做**：不按错误字符串猜「可恢复 / 不可恢复」；不做分钟级自动重试风暴。

## 职责

本地知识库引擎。提供文档向量化、混合检索（向量+BM25）、文档分块、嵌入模型管理、主机记忆、对话索引、加密导入导出。Agent 通过它实现"跨会话事实记忆"（L2）和"对话经验召回"（L3）。

## 文件 / 规模

多文件，主入口：`electron/services/knowledge/index.ts`（~1916 行）

| 文件 | 行数 | 说明 |
|------|:---:|------|
| `index.ts` | 1916 | 核心：文档/记忆/对话索引、搜索、设置、导入导出、备份恢复 |
| `storage.ts` | 679 | 向量存储（LanceDB），启动时检测损坏先尝试备份恢复 |
| `backup.ts` | 230 | 备份/恢复/列表/轮转纯函数（含 .corrupted 标记联动） |
| `embedding.ts` | 564 | 嵌入计算（本地 Transformers.js / 远程 API） |
| `chunker.ts` | 441 | 文档分块（固定/语义/段落） |
| `bm25.ts` | 334 | BM25 关键词检索 |
| `model-manager.ts` | 325 | 嵌入模型下载/切换 |
| `context-knowledge.ts` | 244 | 上下文知识管理 |
| `mcp-adapter.ts` | 148 | MCP 知识源适配 |
| `memory-utils.ts` | 139 | 记忆相似度/去重 |
| `reranker.ts` | 117 | 检索结果重排 |
| `types.ts` | 112 | 共享类型 |
| `crypto.ts` | 20 | 加密/解密 |

## 公开 API（KnowledgeService，40 个 public 方法）

### 初始化 / 生命周期

| 方法签名 | 用途 |
|---------|------|
| `async initialize(): Promise<void>` | 加载模型、打开向量存储、扫描索引 |
| `setMcpService(mcpService: McpService): void` | 注入 MCP（延迟注入：MCP 依赖 Knowledge 类型，循环依赖规避） |
| `isReady(): boolean` | 是否完成初始化 |
| `isEnabled(): boolean` | 配置中是否启用 |
| `dispose(): void` / `async disposeAsync(timeoutMs?): Promise<void>` | 销毁服务 |
| `async rebuildAllIndices(force?): Promise<{durationMs, documentCount, ...}>` | 重建所有索引 |
| `async repairIndex(): Promise<{checked, added, durationMs}>` | 增量修复：只对向量库或 BM25 中缺失的文档重新 embed + 写入，不清空已有数据 |

### 备份 / 恢复

| 方法签名 | 用途 |
|---------|------|
| `async createBackup(): Promise<{success, backupPath?, error?}>` | 手动创建一份备份（不受时间间隔限制） |
| `listBackups(): BackupEntry[]` | 列出所有备份（按时间倒序） |
| `async restoreBackup(backupPath?): Promise<{success, backupPath?, error?}>` | 从备份恢复，恢复后自动重新 initialize + 增量补差集 |
| `deleteBackup(backupPath): boolean` | 删除指定备份（安全检查：只允许删 backups 目录内） |

### 文档管理

| 方法签名 | 用途 |
|---------|------|
| `async addDocument(doc: ParsedDocument, options?): Promise<string>` | 添加文档（分块+嵌入+存储） |
| `async removeDocument(docId, forceCompact?, skipSave?): Promise<boolean>` | 删除单文档 |
| `async removeDocuments(docIds: string[]): Promise<{success, failed}>` | 批量删除 |
| `getDocument(docId): KnowledgeDocument \| undefined` | 获取单文档 |
| `getDocuments(): KnowledgeDocument[]` | 全部文档 |
| `getDocumentsByHost(hostId): KnowledgeDocument[]` | 按主机筛选 |
| `getDocumentsByTag(tag): KnowledgeDocument[]` | 按标签筛选 |
| `isDuplicate(content): {isDuplicate, existingDoc?}` | 内容查重 |

### 搜索

| 方法签名 | 用途 |
|---------|------|
| `async search(query, options?: Partial<SearchOptions>): Promise<SearchResult[]>` | 主搜索入口（混合：向量+BM25+rerank） |
| `async getHostKnowledge(hostId): Promise<SearchResult[]>` | 按主机获取相关知识 |
| `async buildContext(query, options?): Promise<string>` | 构建可注入 prompt 的上下文文本 |

### 主机记忆（L2 持久化事实记忆）

| 方法签名 | 用途 |
|---------|------|
| `async addHostMemory(hostId, memory, options?): Promise<string \| null>` | 直接添加记忆 |
| `async addHostMemorySmart(hostId, memory, options?): Promise<SmartMemoryResult>` | 智能添加：去重+合并 |
| `async searchHostMemories(hostId, query?, limit?): Promise<SearchResult[]>` | 检索主机记忆 |
| `async getHostMemoriesForPrompt(hostId, contextHint?, maxMemories?): Promise<string[]>` | 获取拼装好的记忆字符串（注入 prompt 用） |
| `async getHostMemoriesWithMetadata(hostId, contextHint?, maxMemories?): Promise<{content, createdAt, ...}[]>` | 获取记忆+元数据 |
| `getHostMemoryCount(hostId): number` | 计数 |
| `async clearHostMemories(hostId): Promise<number>` | 清空主机记忆 |
| `async migrateNotesToKnowledge(hostId, notes): Promise<number>` | 老 notes 字段一次性迁移 |

### 对话索引（L3 历史经验召回）

| 方法签名 | 用途 |
|---------|------|
| `async indexConversation(entry: ConversationIndexEntry): Promise<string \| null>` | 索引一次对话（Agent run 完成后异步调用） |
| `async searchConversations(query, hostId?, limit?): Promise<ConversationSearchResult[]>` | 语义检索历史对话 |
| `async backfillConversationIndex(records): Promise<{indexed, skipped, failed}>` | 老历史记录批量回填索引 |

### 模型管理

| 方法签名 | 用途 |
|---------|------|
| `getModels(): ModelInfo[]` | 可用模型列表（**不是** `getAvailableModels`） |
| `getModelStatuses(): ModelStatus[]` | 各模型状态（已下载/使用中等） |
| `async downloadModel(modelId: ModelTier, onProgress?): Promise<void>` | 下载模型 |
| `async switchModel(modelId: ModelTier): Promise<void>` | 切换模型 |

### 设置 / 统计

| 方法签名 | 用途 |
|---------|------|
| `getSettings(): KnowledgeSettings` | 获取设置 |
| `async updateSettings(settings: Partial<KnowledgeSettings>): Promise<void>` | 更新设置 |
| `async getStats(): Promise<KnowledgeStats>` | 统计信息 |

### 导入 / 导出（**不是** `importKnowledge` / `exportKnowledge`）

| 方法签名 | 用途 |
|---------|------|
| `async exportData(exportPath): Promise<{success, error?, hasEncryptedData?, ...}>` | 导出 |
| `async checkImportData(importPath): Promise<{hasPassword, hasEncryptedData, ...}>` | 导入前校验（密码/版本检查） |
| `async importData(importPath): Promise<{success, error?, imported?, ...}>` | 导入 |
| `async clear(): Promise<void>` | 清空全部数据 |

## 核心类型 / 接口

```ts
interface KnowledgeDocument {
  id: string; title?: string; content: string
  metadata?: Record<string, unknown>
  hostId?: string; tags?: string[]
  createdAt: number; updatedAt: number
}

interface SearchResult {
  docId: string; chunkId: string
  content: string; score: number
  metadata?: ChunkMetadata
}

interface KnowledgeSettings {
  enabled: boolean
  chunkSize: number; chunkStrategy: ChunkStrategy
  modelTier: ModelTier
  maxDocuments?: number
}

interface ConversationIndexEntry {
  id: string; userTask: string; finalAnswer: string
  hostId?: string; sessionId: string; timestamp: number
}

type ChunkStrategy = "fixed" | "semantic" | "paragraph"
type ModelTier = "lite" | "standard" | "large"
type MemoryVolatility = "stable" | "moderate" | "volatile"
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `ConfigService` | **必需** | 构造时注入，读知识库设置 |
| `AiService` | **必需** | 构造时注入，远程嵌入 API（如配置） |
| `McpService` | 可选 | 通过 `setMcpService` 延迟注入，MCP 知识源 |

## 关键行为 / 数据流

**文档添加 → 可搜索**：
1. `addDocument(doc)` → `Chunker.chunk(content, strategy)` → `DocumentChunk[]`
2. → `EmbeddingService.embedChunks(chunks)` → 向量数组
3. → `Storage.addVectors(docId, chunks, vectors)` + `BM25.addDocument`
4. 文档元数据写入 `documents.json` 索引

**搜索（混合检索）**：
1. `search(query)` → 向量搜索 top-K + BM25 搜索 top-K 并行
2. → `Reranker.fusion()` 合并 → 去重 → 返回 SearchResult[]

**主机记忆（智能合并）**：
1. `addHostMemorySmart(hostId, memory)` → 先 `searchHostMemories` 找相似项
2. → 命中阈值则合并/覆盖，否则新增（行为见 `memory-utils.ts`）

**对话索引（异步）**：
1. Agent `finalizeRun` 完成后异步调用 `indexConversation`
2. → 提取 user task + final answer → 嵌入 → 入向量库（独立表）

## 关键约束

- **必须 `initialize()` 后才能搜索**——未就绪时 `search` 直接返回空数组
- **大文档必须分块**——`Chunker.chunk` 按 `chunkStrategy` 分段
- **嵌入模型下载不阻塞启动**——后台下载，`ModelManager` 通过 EventEmitter 报告进度
- **加密统一走 `crypto.ts`**——不得在其它模块内联实现
- **导入导出方法叫 `importData` / `exportData`**——不是 `importKnowledge` / `exportKnowledge`
- **MCP 通过 `setMcpService` 延迟注入**——不能放进构造参数（循环依赖）
- **主机记忆相关方法名都带 `HostMemory`**（如 `searchHostMemories`、`getHostMemoriesForPrompt`），不是 `getHostMemory` / `deleteHostMemory`
- **`data_corrupted` 仅重建向量侧**——BM25 为独立 JSON，损坏时保留 BM25，启动增量补向量即可
- **已标损坏时禁止自动备份**——避免把坏库存成最新备份、把好的轮替掉。自动备份仍在启动开头、向量库尚未打开时做（磁盘是上次退出状态，复制安全），受 30 分钟间隔限制，保留最近 3 份
- **打开失败不得清表**——缺文件、读不开时保留现有向量表，不得整表丢掉；只有换了嵌入模型、维度对不上才清旧向量
- **恢复从新到旧试备份**——启动发现损坏标记时先恢复；读得开才算成功。最新这份读不开就试更早的；都读不开则跳过启动补建，不要把「枚举失败」当成「库是空的」去全量重建
- **损坏现场集中存放并限量**——现场统一放在 `knowledge-broken/`，只留最近 2 份；同一轮里试更早备份时换下来的副本不留档（前提是确认它确实是副本，前面的恢复没做成时换下来的仍是用户原始数据，必须留）；老版本散落在数据目录根下的现场启动时收编进来一并轮转
- **一批备份试遍都读不开就记下结论**——下次启动跳过恢复，不再用几百兆的复制重新验证注定的结果；备份有增删更新、或用户手动发起恢复时该结论作废
- **恢复后增量补差集**——读得开的备份换回去之后，只补和当前文档清单的差集，不全量重做向量
- **孤儿 chunk 后台清理**——`initialize()` 后 `setImmediate` 定向删 chunk；残留 &lt; 50 跳过整表重建
- **退出时 `disposeAsync`**——主进程 `cleanupAllServices` / SIGINT·SIGTERM 会 compact LanceDB 并停 worker
- **嵌入推理**——`@huggingface/transformers` v4 + `device: auto`（macOS→WebGPU via `gpu`、Linux x64→`gpu`、Windows→`dml`；Windows 不可用 `gpu` 别名，因 ORT 禁止 webgpu+dml 同会话）；加速 EP 初始化失败（无 DX12 GPU、驱动不兼容等）自动回退 `cpu`；设置项 `embeddingDevice`
