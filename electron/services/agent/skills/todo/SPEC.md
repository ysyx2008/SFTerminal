/**
 * 本地待办技能 (todo)
 *
 * > Last verified: 2026-07-28
 *
 * ## 设计目标
 *
 * 桌面待办面板要像秘书一样**综合权衡**后再提示，而不是只靠 priority 标签或「逾期最红」：
 *
 * - **预防优于追责**：即将到期单独成区并置于活跃列表最前，视觉热度 ≥ 已逾期；催在逾期前。进入条件（任一即可）：本地日历「今天」截止、**绝对剩余 ≤ 48 小时**、或剩余时间占比 ≤ 20%。分区互斥：符合条件的活跃项只出现在「即将到期」，不重复出现在进行中/待办
 * - **双通道不抢戏**：
 *   - **标题色** = 综合关注度：重要度（`priority`）× 时限档 × 陈旧度（`createdAt`，轻量补洞）；「今天」主要靠分区 + 截止芯片警示色突出，不为「剩 N 天」再拆多档标题色
 *   - **行背景进度** = 有 `dueDate` 时按**绝对剩余时间**画条（见下），**不是**「预留时间用掉多少」；逾期/无截止不画条
 * - **行进度条语义（绝对剩余）**：用户扫一眼要分清「明天要交」与「两周后的事」——今天建、明天交的任务不能因比例≈100% 而看起来从容。条长 = `min(1, remainingMs / 14d)`（14 天封顶满条）；颜色复用项目现成的**跨主题固定三档强弱阶梯**（`main.css` 已有、专为红→橙→绿三档强弱设计，永远是 Tailwind 原色不随主题降饱和），真正换色相而非同色调深浅或透明度：
 *   - 剩 ≤ 2 天 → `--brand-alert`（红，紧急）
 *   - 剩 ≤ 7 天 → `--brand-caution`（橙，该关注了）
 *   - 剩 > 7 天 → `--brand-vital`（绿，从容）
 *   均以低浓度 `color-mix(... 14–16%, transparent)` 浅透叠底，不做纯色实块
 *   **Hover**：速览卡**跟随鼠标**瞬时出现（`TodoRowHoverTip.vue`，`Teleport` 到 body + `position: fixed`）；贴光标右下，用 `ResizeObserver` 测真实渲染尺寸做视口翻折/夹取（**不用固定宽高估算**——卡片内容量随条目差异很大，估算值必然与真实尺寸脱节导致翻转判断错误）。内容：标题（≤2 行）+ 备注摘要（≤3 行，≤200 字）、状态/优先级徽标、截止日期 + 色点（复用红/橙/绿三档）+ 剩余文案、标签、创建/更新/完成时间；有进度条时附条长含义。完成/删除按钮悬停时隐藏速览。紧急档判定 (`dueUrgencyTier`) 与进度条颜色共用同一函数，不重复散落阈值。目标是多数情况不用点开右侧详情
 * - **列表排序（面板）**：分区顺序为 即将到期 → 已逾期 → 进行中 → 待办 → 已完成；区内只按重要度 `urgent > high > normal > low`，同档按创建时间
 * - **颜色（跟主题走）**：今天分区/芯片/`strong|critical` 标题用 `--brand-alert`；已逾期分区/芯片与高优/`medium|mild` 标题用 `--accent-warning`；普通标题 `--text-primary`；进度条见上档；禁止硬编码 hex
 * - **陈旧度只补洞**：活跃、无即将到期/逾期时，high/urgent 本就轻度着色；创建超过约 7 天再上浮一档（最高 medium），不得到 critical / 不得盖过「即将到期」
 * - **完成/取消**：弱化划线，忽略关注度着色与进度条
 * - **Tab 注意力**：有尚未看过的逾期时 Tab 闪烁；打开待办面即确认当前逾期集合，之后仅新增逾期再闪（持续忽视由秘书主动通知兜底）
 * - **本版范围**：面板展示与面板内排序；不改数据模型、后端 `TodoService` 列表排序、心跳 `render.ts`
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
 * - UI：`src/components/Todo/TodoPanel.vue` — 轻量 CRUD（列表/筛选、新建标题+截止、完成/重开/删除）；标题色/行进度见上方「设计目标」
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
