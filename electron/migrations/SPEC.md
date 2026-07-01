# Migrations 子系统 SPEC

> Last verified: 2026-07-01

## 职责

版本化数据迁移框架，保障老用户跨版本平滑升级。每次 schema 变更（字段重命名、格式调整、目录重构）对应一个 migration，按版本顺序在启动时执行；失败可断点续传，迁移前与 auto-update 前自动备份关键用户数据。

## 文件结构

| 文件 | 职责 |
|------|------|
| `types.ts` | `Migration` / `MigrationContext` / `MigrationPhase` 接口定义 |
| `runner.ts` | `MigrationRunner` 类：注册、按 phase 执行、断点续传 |
| `index.ts` | 注册中心：`allMigrations` 数组 + `getMigrationRunner()` 单例 |
| `backup.ts` | `createBackup()`：迁移/auto-update 前备份关键用户数据，保留最近 5 份 |
| `vN-xxx.ts` | 各版本具体迁移逻辑（v1-v7） |

## 执行模型

### Phase 分组

migration 按 `phase` 字段分组，对应不同服务初始化时机。`main.ts` 在三个时机调用 `runner.run(phase, ctx)`：

| phase | 调用时机 | 可用依赖 | 典型用途 |
|-------|---------|---------|---------|
| `early` | `main.ts` 顶部，仅 `app.whenReady()` 后 | `configService` + 文件系统 + lazy 模块单例 | 配置/凭证类迁移（v7） |
| `startup` | 主窗口创建前 | `configService` + 文件系统 | 历史目录重构、大文件扫描（v5、v6），可弹进度窗 |
| `services` | 后端服务全部就绪后 | `configService` + `hostProfileService` + `knowledgeService` + `watchService` 等 | 需要调用服务 API 的迁移（v2、v3） |

### 版本追踪与断点续传

- `schemaVersion` 存在 `qiyu-terminal-config.json`（`ConfigService` 持有）
- `runner.run()` 筛选 `version > currentVersion` 的 pending migration，按 version 升序执行
- 每个 migration 成功后**立即** `setSchemaVersion(version)`，即使后续 migration 失败，下次启动也从断点继续
- 单个 migration 抛错时停止执行后续 migration（不阻塞 app 启动，仅记 error log）

### 备份

- `runner.run()` 检测到 pending migration 时，执行第一个之前调 `createBackup(userDataPath, 'pre-migration-vN')`
- `createBackup` 复制 `BACKUP_TARGETS`（配置、watch、host-profiles、knowledge、history）到 `{userData}/backups/{label}-{timestamp}/`
- 保留最近 5 份，超出按 mtime 倒序清理
- 备份失败不阻塞迁移（best-effort，仅记 error）

## 公开 API

### MigrationRunner（`runner.ts`）

| 方法 | 用途 |
|------|------|
| `register(migration)` / `registerAll(migrations)` | 注册 migration，自动按 version 升序排序 |
| `run(phase, context): Promise<number>` | 执行指定 phase 的 pending migration，返回成功执行数 |
| `getPendingCount(phase, currentVersion)` | 查询指定 phase 待执行数量（用于进度提示） |
| `getLatestVersion()` | 返回已注册的最大 version |

### MigrationContext

每个 migration 收到的上下文，按 phase 提供不同完整度的依赖：

```typescript
interface MigrationContext {
  configService: ConfigService       // 所有 phase 可用
  userDataPath: string                // 所有 phase 可用
  // 以下仅 services phase 提供
  hostProfileService?: HostProfileService
  knowledgeService?: KnowledgeService
  watchService?: WatchService
  schedulerStore? / schedulerService? // 旧调度器迁移用（v3）
}
```

### 备份（`backup.ts`）

| 函数 | 用途 |
|------|------|
| `createBackup(userDataPath, label): string \| null` | 创建一份备份，返回备份目录路径；无可备份数据时返回 null |

## Migration 注册清单

| version | name | phase | 说明 |
|---------|------|-------|------|
| v1 | `ssh-group-to-groupid` | services | SSH session 从 groupName 改为 groupId |
| v2 | `host-notes-to-knowledge` | services | host-profile 的 notes 迁入 L2 知识文档 |
| v3 | `scheduler-to-watch` | services | 旧定时任务整合进关切系统 |
| v4 | `ui-theme-mode` | early | UI 主题模式字段归一化 |
| v5 | `agent-history-per-session` | startup | Agent 历史从按日数组改为按会话单文件 |
| v6 | `watch-history-split` | startup | watch 内心独白从 agent 历史树拆到独立 watch 树 |
| v7 | `im-bastion-plaintext-and-e1-to-g1` | early | IM/堡垒机明文凭证迁入 credential.service（g1: 加密）+ 存量 e1: 升级为 g1: |

## 新增 Migration 流程

1. 创建 `vN-xxx.ts`，实现 `Migration` 接口（`version` / `name` / `phase` / `migrate(context)`）
2. 在 `index.ts` 的 `allMigrations` 数组追加 import 和注册
3. 必须幂等：再次执行不重复迁移、不丢数据（用 schemaVersion 或目标状态判断是否已完成）
4. 涉及大文件扫描时复用 `createMigrationProgressWindow` / `setMigrationProgress`（参考 v5、v6）
5. 写单测：`__tests__/vN-xxx.test.ts`，覆盖正常迁移、幂等、错误降级

## 关键约束

- **幂等性**：所有 migration 必须可重复执行，断点续传依赖此性质
- **不阻塞启动**：单个 migration 失败仅记 log，不让 app 崩溃；下次启动重试
- **schemaVersion 立即落盘**：每个 migration 成功后立即 `setSchemaVersion`，不等 batch 结束
- **备份先于迁移**：检测到 pending 时先备份，备份失败不阻塞（best-effort）
- **phase 依赖严格**：early phase 不应访问未初始化的后端服务；services phase 才能用 hostProfile/knowledge/watch
- **跨 phase 顺序**：early → startup → services，同 phase 内按 version 升序
- **不动正在运行的运行时数据**：startup phase 的文件迁移发生在主窗口前，避免与运行时写入冲突

## 已知限制

- 备份目标 `BACKUP_TARGETS` 是硬编码列表，新增用户数据目录需手动同步
- migration 无法回滚：一旦 `setSchemaVersion` 落盘，即使后续逻辑出错也视为已完成
- CLI 模式不跑 migration runner（CLI 通常是 Electron 已迁移后的瘦客户端）
