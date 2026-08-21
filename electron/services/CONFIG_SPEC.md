# Config Service SPEC

> Last verified: 2026-07-16

## 职责

应用配置持久化层。提供类型安全的 key-value 存取，所有配置持久化到本地 JSON 文件（`electron-store`），服务启动时加载、修改时即时写盘。不包含业务逻辑——纯存取。

从仓库跑的命令行默认进沙箱，只借用桌面的模型配置和密钥，不写真实历史。装机后的正式命令默认与桌面共用配置。回归测试用临时目录，同样会借用。

敏感项长期存放心智模型见 credential.service。

日常写盘前由 `config-backup.ts` 对关键配置做轻量滚动备份；读损坏时优先从备份恢复并强制界面提示（禁止静默清空）。迁移/升级整包仍只用 `electron/migrations/backup.ts`（**零改动**）。

## 文件 / 规模

- `electron/services/config.service.ts` — ConfigService
- `electron/services/config-backup.ts` — 滚动备份 / 恢复 / recovery notice

## 公开 API

配置服务共 78 个 public 方法，均为 `getXxx` / `setXxx` / `addXxx` / `updateXxx` / `deleteXxx` 模式。无 private 方法。

| 分类 | 方法签名 | 备注 |
|------|---------|------|
| **AI 相关** | `getAiProfiles() / setAiProfiles(arr)` | AI 模型配置列表 |
| | `addAiProfile(profile) / updateAiProfile(profile) / deleteAiProfile(id)` | CRUD |
| | `getActiveAiProfile() / setActiveAiProfile(profile)` | 当前激活的 AI 配置 |
| | `hasVisionCapability()` | 当前模型是否支持视觉 |
| **SSH/会话** | `getSshSessions() / setSshSessions(arr)` | SSH 连接配置列表 |
| | `addSshSession(conf) / updateSshSession(conf) / deleteSshSession(id)` | CRUD |
| | `getSessionGroups() / setSessionGroups(arr)` | 会话分组 |
| | `addSessionGroup(g) / updateSessionGroup(g) / deleteSessionGroup(id)` | CRUD |
| | `getSessionSortBy() / setSessionSortBy(v)` | 会话排序方式 |
| | `getDefaultGroupSortOrder() / setDefaultGroupSortOrder(v)` | 默认分组排序 |
| **Agent 相关** | `getAgentMbti() / setAgentMbti(v)` | Agent 性格类型 |
| | `getAgentDebugMode() / setAgentDebugMode(v)` | 调试模式开关 |
| | `getAgentPersonalityText() / setAgentPersonalityText(t)` | 自定义人格描述 |
| | `getAgentName() / setAgentName(n)` | Agent 名称 |
| | `getAgentAvatar() / setAgentAvatar(a)` | Agent 头像 |
| | `getAiRules() / setAiRules(arr)` | AI 行为规则列表 |
| | `getSetupCompleted() / setSetupCompleted(b)` | 初始设置是否完成 |
| | `getAgentOnboardingCompleted() / setAgentOnboardingCompleted(b)` | Agent 引导是否完成（personality_craft 等） |
| | `getAgentOnboardingShown() / setAgentOnboardingShown(b)` | 诞生引导是否已展示（跳过也算，防新 tab 重复触发） |
| **知识库** | `getKnowledgeSettings() / setKnowledgeSettings(s)` | 知识库全局设置 |
| | `updateKnowledgeSettings(partial)` | 部分更新 |
| **MCP** | `getMcpServers() / setMcpServers(arr)` | MCP 服务器列表 |
| | `addMcpServer(s) / updateMcpServer(s) / deleteMcpServer(id)` | CRUD |
| | `getEnabledMcpServers()` | 仅返回启用的服务器 |
| **UI** | `getTheme() / setTheme(t)` | 终端主题 |
| | `getUiTheme() / setUiTheme(t) / getUiThemeMode() / setUiThemeMode(m)` | UI 主题及模式 |
| | `getKeyboardShortcuts() / setKeyboardShortcuts(map)` | 键盘快捷键 |
| | `getLanguage() / setLanguage(l)` | 界面语言 |
| **终端** | `getTerminalSettings() / setTerminalSettings(s)` | 终端行为设置 |
| | `getProxySettings() / setProxySettings(p)` | 代理配置 |
| **书签** | `getFileBookmarks() / setFileBookmarks(arr)` | 文件书签 |
| | `addFileBookmark(b) / updateFileBookmark(b) / deleteFileBookmark(id)` | CRUD |
| | `getLocalBookmarks()` | 仅本地书签 |
| | `getRemoteBookmarks()` | 仅远程书签 |
| **其他** | `get(key) / set(key, value) / has(key)` | 通用存取（底层接口） |
| | `getAll()` | 返回全部配置 |
| | `getSchemaVersion() / setSchemaVersion(n)` | 配置 schema 版本 |
| | `getLogLevel() / setLogLevel(level)` | 日志级别 |
| | `getSponsorStatus() / setSponsorStatus(s)` | 赞助状态 |
| **恢复提示** | `peekRecoveryNotice() / dismissRecoveryNotice()` | 启动恢复/重置后的 UI notice（落盘 `config-recovery-notice.json`） |

内部通过 `private store: Store<StoreSchema>` 实现持久化。`store.set` 在构造后包装为写前调用 `createConfigBackupIfNeeded()`。

### 滚动备份（`config-backup.ts`）

| 项 | 说明 |
|---|---|
| 目录 | `{userData}/config-backups/{iso}/`（与 `backups/` 迁移整包隔离） |
| 目标（lite） | `qiyu-terminal-config.json`、`qiyu-terminal-watches.json`、`qiyu-terminal-scheduler.json`、`credentials.json`、`master.key` |
| 触发 | 主配置 `store.set` 写前；合法 JSON + hash 去重 + **5 分钟去抖**；启动 >24h 无快照则补打 |
| 保留 | 近期槽 **20** + 按天保底 **30 天**（每天最早一份） |
| 恢复顺序 | `config-backups/` 从新到旧第一份 check 通过 → 只读回退 `backups/` 整包内同名文件 |
| Check | 主配置须 parse 为 plain object；可选 JSON 存在则须可 parse；`master.key` 非空 |
| Notice | `restored` \| `reset`；渲染进程 `ConfirmDialog` 提示后 dismiss；IPC `getRecoveryNotice` / `dismiss` |

公开函数：`createConfigBackup` / `createConfigBackupIfNeeded` / `ensureStartupConfigBackup` / `tryRestoreConfigFromBackups` / `peekConfigRecoveryNotice` / `consumeConfigRecoveryNotice` / `dismissConfigRecoveryNotice`。

## 核心类型 / 接口

`ConfigService` 本身不定义新类型，所有配置项类型定义在 `electron/migrations/types.ts` 的 `StoreSchema` 接口中。命名模式与上面方法名的 `<Xxx>` 部分对应。

## 依赖（跨 service）

无运行时跨 service 依赖。`ConfigService` 被几乎所有 service 依赖（它是底层基础设施），但自身不依赖任何其他 service。

## 关键行为 / 数据流

1. `main.ts` 启动 → 实例化 `ConfigService` → `createStore`：明文读 → 失败则 `tryRestoreConfigFromBackups` → 再失败则旧加密迁移 → 仍失败则备份坏文件 + 空默认并 `setConfigRecoveryNotice`
2. 启动成功后 `ensureStartupConfigBackup`；有 notice 时主进程弹窗 + 前端横幅
3. 任意 `setXxx` → 包装后的 `store.set` →（按规则）先备份旧文件 → 再写盘
4. `getXxx()` → 内存值；`getAll()` 完整快照

## 关键约束

- **不得在 ConfigService 中添加业务逻辑**——纯存取层，判断逻辑放在调用方
- **系统级开关只存用户意图**——如「开机启动」：配置层只记录用户选择，不直接产生系统副作用；向操作系统注册/注销由调用方负责，仅在打包后的应用上执行，且每次启动按配置重新应用一遍（自动更新后程序路径变化时可自愈）
- **新增配置项必须同步更新 `migrations/types.ts` 中的 `StoreSchema`**，并考虑迁移路径
- **set 操作即写盘**——高频写入场景（如终端 resize）不得走 ConfigService
- **不得在 getter 中返回可变对象引用**——调用方修改返回值不应影响内部状态
- **恢复/重置必须界面可见**——禁止只打日志的静默清空
- **不修改** `electron/migrations/backup.ts`（升级整包链路隔离）
- 跨进程（桌面+CLI 同 userData）无文件锁；半截 JSON 由 check 拦住（已知限制）
