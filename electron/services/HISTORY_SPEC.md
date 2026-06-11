# History Service SPEC

> Last verified: 2026-06-11（Agent 记录改为按会话单文件 + 原子写入；v5 迁移拆分旧日文件）

## 职责

Agent 对话和聊天记录的持久化存储。按日期分文件存储 JSON 记录，提供按时间、关键词等维度检索，以及完整的导出/导入/清理功能。同时维护 Agent 记录索引以加速搜索。

## 文件 / 规模

单文件：`electron/services/history.service.ts`（~938 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `saveChatRecord(record: ChatRecord): void` | 保存一条聊天记录（**已废弃**，无调用方） | 仅导入流程 |
| `saveChatRecords(records: ChatRecord[]): void` | 批量保存聊天记录（**已废弃**） | 导入流程 |
| `getChatRecords(startDate?, endDate?): ChatRecord[]` | 按日期范围查询聊天记录（**已废弃**） | 导出流程 |
| `rebuildAgentIndex(): void` | 从磁盘重建 Agent 索引 | v5 迁移、维护 |
| `saveAgentRecord(record: AgentRecord): void` | 保存 Agent 执行记录并更新索引 | `agent/index.ts` |
| `getAgentRecords(startDate?, endDate?): AgentRecord[]` | 按日期范围查询 Agent 记录 | 前端历史面板 |
| `getAgentRecordById(id: string): AgentRecord \| undefined` | 按 ID 精确查找 Agent 记录 | 回放/详情查看 |
| `deleteAgentRecord(id: string): boolean` | 按 ID 删除单条 Agent 记录（日文件、索引、关联截图目录） | IPC `history:deleteAgentRecord`、最近对话侧栏删除 |
| `getRecentAgentRecords(limit?, filter?): AgentRecord[]` | 获取最近的 Agent 记录（支持自定义过滤） | `agent/index.ts`、上下文构建 |
| `listAgentHistorySummaries(excludeWakeup?): AgentHistorySummary[]` | 从索引列出全部摘要（首条 user_task 作标题，不读日文件） | IPC `history:listAgentSummaries`、`AiPanel` 历史弹窗（无搜索词时的列表） |
| `searchAgentRecords(keyword: string, limit?): Promise<AgentRecord[]>` | 关键词搜索 Agent 记录（`searchAgentRecordsAdvanced` 的薄封装） | 工具/记忆检索 |
| `searchAgentRecordsAdvanced(options): Promise<SearchAgentRecordsResult>` | 高级搜索：`userTask`、`finalResult`、`user_task`/`user_supplement` 步骤等；`titleOnly` 仅匹配标题 | IPC `history:searchAgentRecords`、`AiPanel` 历史弹窗在用户按回车/点搜索触发全文检索时 |
| `getTokenUsageStats(): TokenUsageStatsResult` | 返回 Token 用量统计 | 设置 UI |
| `getDataPath(): string` | 返回数据目录路径 | `cli/index.ts` 信息展示 |
| `getHistoryPath(): string` | 返回历史记录目录路径 | `cli/index.ts` |
| `exportToFolder(exportPath, configData, hostProfiles?, options?): {success, files[], error?}` | 导出数据到文件夹（含历史、配置、主机档案） | 前端导出功能 |
| `importFromFolder(importPath): {success, imported[], error?}` | 从文件夹导入数据 | 前端导入功能 |
| `cleanupOldRecords(daysToKeep?): {chatDeleted, agentDeleted}` | 清理过期记录 | 维护任务 |
| `getStorageStats(): {chatFiles, agentFiles, totalSize}` | 返回存储统计信息；`agentFiles` = 有 Agent 记录的天数（非会话文件数） | 设置 UI |

## 核心类型 / 接口

### ChatRecord（@shared 共享类型）
`{ id: string, role: "user"|"assistant", content: string, timestamp: number }`

### AgentRecord（@shared 共享类型）
含 `id`、`sessionId`、`timestamp`、`summary`、`tokenUsage` 等完整执行信息。

### AgentIndexEntry（本文件内部）
`{ id, timestamp, duration, dateStr, userTask, terminalType, sshHost?, status, tokenUsage? }`，常驻内存（`_indexCache`），用于排序/过滤/搜索时避免读取完整日期文件。

## 依赖（跨 service）

无跨 service 依赖。纯文件 I/O，不依赖其他 service。

## 关键行为 / 数据流

**Agent 存储机制**（v5 起）：
- 每条会话一个 JSON 文件：`history/agent/YYYY-MM-DD/{sessionId}.json`（单条 `AgentRecord` 对象，非数组）
- 写入使用原子 rename（`electron/utils/atomic-write.ts`），崩溃时保留旧文件
- 损坏单文件隔离为 `.corrupt.{timestamp}`，不影响同天其他会话
- v5 迁移将旧 `agent/YYYY-MM-DD.json` 数组拆分为单文件，旧文件改名为 `.json.migrated` 保留 30 天

**Chat 存储**（遗留）：`history/chat/YYYY-MM-DD.json`，当前无写入方，仅导出/导入兼容。

**索引机制**：Agent 记录额外维护索引文件（`history/agent-index.json`，常驻内存 `_indexCache`），`saveAgentRecord` 时同步更新、缺失时 `rebuildIndex` 全量重建。`getRecentAgentRecords` / `listAgentHistorySummaries` / `searchAgentRecordsAdvanced` 均以索引为候选来源，避免全量读日文件。

**搜索性能（searchAgentRecordsAdvanced，async）**：先用内存索引按「时间窗 + filter（cast 到索引条目，与 `getRecentAgentRecords` 同款）」筛候选，`titleOnly` 时关键字匹配也在索引层完成。
- `titleOnly`：候选即命中集，仅为前 `limit` 条读回完整记录，零全量扫描；
- full：关键字可能命中 `finalResult`/steps 正文，须读完整记录二次匹配，但仅读候选所在日期文件，且逐文件 `await`（`fs.promises`）让出事件循环，避免历史量大时同步遍历阻塞主进程导致界面冻结。
- 历史规模极大时的根治方案是迁移至 SQLite + FTS（当前未做）。

**导入/导出**：
- 导出：合并 `chat/`、`agent/`、配置文件、主机档案为文件夹
- 导入：合并到现有数据目录（非覆盖），支持增量合并

## 关键约束

- **记录一旦保存不得修改历史内容**——只能追加，不能覆写（审计完整性）
- **Agent 记录 ID 必须全局唯一**（UUID v4）
- **数据文件编码必须为 UTF-8**
- **`cleanupOldRecords` 默认保留 90 天**，调用方不得传入小于 7 天的值
- **导出时 SSH 密码默认不包含**（`includeSshPasswords` 须显式开启）
