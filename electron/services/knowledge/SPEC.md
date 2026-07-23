# Knowledge Service SPEC

> Last verified: 2026-07-23

## 设计目标

### utilityProcess 隔离 + 桌面端禁止静默回退主进程（2026-07-23）

- **问题**：Embedding / LanceDB 设计进 utilityProcess；打包 `asarUnpack` 缺传递依赖时 worker ESM 失败，旧逻辑 `warn` 后回退主进程——功能「看似能用」，Windows 上堵 UI，测试也发现不了。
- **成功标准**：
  - worker 所需依赖（含 `onnxruntime-common`、`apache-arrow`、`@huggingface/jinja`、`@huggingface/tokenizers` 等）必须在 `asarUnpack` 物理目录，ESM `import()` 可解析。
  - **桌面端（utilityProcess 可用）**：worker 初始化失败 → **直接失败**（error 日志 + 知识库不可用状态），**禁止**再 load 进主进程。
  - **唯一例外**：CLI / shim 下 `utilityProcess.fork` 不可用时走进程内模式（无 UI、也无 worker 可选）——这不是「失败后降级」。
- **明确不做**：不在 worker 失败后再偷偷 in-process「救活」；不靠关键词解析错误串做分类。

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
- **备份恢复优先于清表重建**——`VectorStorage.initialize` 启动时若检测到 `.corrupted` 标记，先调 `backup.restoreBackup()` 从最近备份恢复；恢复成功删除标记、worker 启动即用恢复数据；恢复失败才走 dropTable + 全量重建。自动备份在 `KnowledgeService.initialize()` 开头后台异步触发（worker 启动前，磁盘是上次退出状态，文件级复制安全），受 30min 间隔限制，保留最近 3 份。备份时跳过 `.corrupted` 标记避免恢复后误触发
- **恢复后增量补差集**——`restoreBackup()` 恢复磁盘文件后调 `vectorStorage.forceReinitialize()` 丢弃内存句柄，再 `initialize()` 触发 `checkAndRebuildIndex` 自动比对 docIds 差集，只补备份与当前 documents.json 的差集，不全量重 embed
- **孤儿 chunk 后台清理**——`initialize()` 后 `setImmediate` 定向删 chunk；残留 &lt; 50 跳过整表重建
- **退出时 `disposeAsync`**——主进程 `cleanupAllServices` / SIGINT·SIGTERM 会 compact LanceDB 并停 worker
- **嵌入推理**——`@huggingface/transformers` v4 + `device: auto`（macOS→WebGPU via `gpu`、Linux x64→`gpu`、Windows→`dml`；Windows 不可用 `gpu` 别名，因 ORT 禁止 webgpu+dml 同会话）；加速 EP 初始化失败（无 DX12 GPU、驱动不兼容等）自动回退 `cpu`；设置项 `embeddingDevice`
