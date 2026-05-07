# Config Service SPEC

> Last verified: 2026-05-07

## 职责

应用配置持久化层。提供类型安全的 key-value 存取，所有配置持久化到本地 JSON 文件（`electron-store`），服务启动时加载、修改时即时写盘。不包含业务逻辑——纯存取。

## 文件 / 规模

单文件：`electron/services/config.service.ts`（~1002 行）

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
| | `getAgentOnboardingCompleted() / setAgentOnboardingCompleted(b)` | Agent 引导是否完成 |
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

内部通过 `private store: Store<StoreSchema>` 实现持久化。

## 核心类型 / 接口

`ConfigService` 本身不定义新类型，所有配置项类型定义在 `electron/migrations/types.ts` 的 `StoreSchema` 接口中。命名模式与上面方法名的 `<Xxx>` 部分对应。

## 依赖（跨 service）

无运行时跨 service 依赖。`ConfigService` 被几乎所有 service 依赖（它是底层基础设施），但自身不依赖任何其他 service。

## 关键行为 / 数据流

1. `main.ts` 启动 → 实例化 `ConfigService` → 调用 `electron-store` 读取本地 JSON
2. 任意 service 调用 `getXxx()` → 直接返回内存中值（无 I/O）
3. 任意 service 调用 `setXxx(value)` → 更新内存 → `electron-store` 即时写盘
4. `getAll()` 返回完整配置快照，用于调试/导出

## 关键约束

- **不得在 ConfigService 中添加业务逻辑**——纯存取层，判断逻辑放在调用方
- **新增配置项必须同步更新 `migrations/types.ts` 中的 `StoreSchema`**，并考虑迁移路径
- **set 操作即写盘**——高频写入场景（如终端 resize）不得走 ConfigService
- **不得在 getter 中返回可变对象引用**——调用方修改返回值不应影响内部状态
