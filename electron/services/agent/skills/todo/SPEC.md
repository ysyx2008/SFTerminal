/**
 * 本地待办技能 (todo)
 *
 * > Last verified: 2026-07-17
 *
 * ## 职责
 *
 * 管理用户**本地秘书待办**的结构化真相源。写入走 `todo_*` 工具或桌面待办面板 IPC，心跳通过 `render.ts` 注入摘要，关切「待办截止提醒」通过 `todo_list` 决策是否 `talk_to_user`。
 *
 * ## 真相源入口（OOP）
 *
 * - **`TodoService`**（[`store.ts`](./store.ts)）+ `getTodoService()`：主进程完整门面
 * - 公开表面：`load` / `save` / `mutate` / `list` / `create` / `update` / `complete` / `delete` / `countOverdue` / `onChanged`
 * - `TodoItem` 仍是 `@sailfish/shared-types` **interface**（IPC / JSON 线格式），不做实体类
 * - [`api.ts`](./api.ts) 为 IPC/CLI 薄 facade（`listTodos` → `getTodoService().list` 等）
 *
 * ## 存储
 *
 * - 路径：`{userData}/agent-workspace/TODO.json`
 * - Schema：`@sailfish/shared-types` 的 `TodoItem` / `TodoStoreData`
 * - **勿**将 `TODO.json` 加入文件工具免确认白名单；仅技能 / 面板 IPC 可写
 *
 * ## 工具
 *
 * | 工具 | 用途 |
 * |---|---|
 * | `todo_list` | 列表；过滤/排序；默认排除 completed/cancelled |
 * | `todo_create` | 新建；自动 id/createdAt/updatedAt |
 * | `todo_update` | 改字段与 status；管 completedAt |
 * | `todo_complete` | 快捷标记完成 |
 * | `todo_delete` | 彻底删除 |
 *
 * ### 状态机
 *
 * - `todo_update` 可改 `status`（含取消、重新打开）
 * - 进入 `completed` → 写 `completedAt`
 * - 离开 `completed` → 清空 `completedAt`
 * - **`createdAt` 不可改**
 *
 * ## 桌面待办面板
 *
 * - 入口：TabBar 固定区，在**联络右侧**、新建按钮之前（`[… 联络] [待办] [+]`）
 * - 形态：伪 Tab（`terminalStore.todosActive`），非 Agent / Workbench 会话
 * - IPC：`todo:list` / `create` / `update` / `complete` / `delete` / `countOverdue`；写入后广播 `todo:changed`
 * - API：`skills/todo/api.ts` → `TodoService`（与 Agent 工具共用单例与写队列）
 * - UI：`src/components/Todo/TodoPanel.vue` — 轻量 CRUD（列表/筛选、新建标题+截止、完成/取消/重开/删除）
 *
 * ## 与其它系统边界
 *
 * | 系统 | 关系 |
 * |---|---|
 * | watch 心跳 `{{TODO}}` | 只 import `render.ts` → `renderTodosForContext()`，不拉技能注册 |
 * | 关切模板 | `skills: ['todo']` + 调 `todo_list`（方案 A） |
 * | calendar VTODO | 工具名 `calendar_todo_*`，CalDAV 远端 |
 * | dingtalk | 钉钉云待办，独立 API |
 * | 内置 `plan` | 单次会话执行计划，与跨会话本地待办无关 |
 *
 * ## 旧 TODO.md 兼容
 *
 * - **正式 migration v9**（`todo-md-to-json-prepare`）：有内容的 `TODO.md` 且 `TODO.json` 无有效条目 → 备份 `TODO.md.bak`，标记 `migrations/todo-md.json` = `pending`
 * - 标记路径：`{userData}/agent-workspace/migrations/todo-md.json`（`migrations/` 为工作区免确认目录，供日后其它升级标记复用；根目录旧 `TODO.migration.json` 启动时自动迁入）
 * - **Deferred（`migrate-legacy.ts`）**：services 就绪后在 **`__companion__` 联络**上征询（短 `user_task` + `contextHint` 完整 SOP，不改编 proactive）：
 *   1. SOP 要求 Agent **必须** `talk_to_user`（禁止纯文本收工）
 *   2. **互斥兜底**：`migrate-legacy` 在 callbacks 里侦测本轮是否出现 `talk_to_user`；**仅当未出现**时，才用与 `messageUser` 同形路径补发桌面 toast + IM（避免与正常投递双发）
 *   3. 用户在联络回复 → 沿用会话上下文按 SOP：`todo_create` / `write_text_file` 写 `deferred`|`skipped`|`done`（标记在 `migrations/`，免确认）
 *   4. 有效 `TODO.json` 时由代码收尾残留 `TODO.md`（不经 shell）
 * - marker：`pending`|`deferred`（下次再问）|`failed`|`skipped`|`done`
 * - 工具结果仍可附迁移提示（兜底）；**不**在代码里启发式解析 Markdown 字段
 * - 不新开任务 tab、不 `free`、不改 `consumeProactiveContext`
 * - **勿**将 `TODO.json` / `TODO.md` 加入免确认；仅 `migrations/` 整目录免确认
 *
 * ## 非目标
 *
 * - 与日历 / 钉钉双向同步
 * - 运行时自动 md→json 解析
 * - `TodoItem` 实体类 / 前端 OOP
 */
