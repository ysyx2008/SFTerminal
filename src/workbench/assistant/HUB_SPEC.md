# 助手 Hub 交互模型 SPEC

> Last verified: 2026-06-21  
> 涵盖范围：`App.vue` / `TabBar.vue` / `RecentConversationsPanel.vue` / `terminal.ts` 中与助手 Hub 相关的所有交互规则。

---

## 一、设计目标

将过去"每个本地助手对话独占一个独立 Tab"的模型，改为**单一助手工作台（Hub）+ 最近对话侧栏**，使：
- 任意数量的本地助手对话共用一个工作台区域，通过侧栏切换
- 终端 Tab（local/ssh）保持独立全屏，不受影响
- 用户可将任意会话"提升"为独立 Tab，兼顾重度多任务需求
- 外部渠道（IM/Watch 通知）统一汇集到**联络常驻 Tab**（`__companion__`）

---

## 一·A. 任务 / 联络双入口模型（2026-06-21 新增）

> 产品级定位（任务 vs 联络的关系形态、为何不合并、联络上下文设计）见 `.cursor/rules/project-architecture.mdc`「任务 / 联络 双入口模型」。本节只描述 TabBar 交互机制。

TabBar 顺序：`[任务] [可滚动普通 tab 区] [批量按钮] [联络] [待办] [新建+]`。

| 入口 | 位置 | 行为 |
|---|---|---|
| **任务**（`tab-home` 按钮） | 最左端 | 始终可见；激活态为无可见 tab 且非待办面；点击 `focusTaskArea()` 回到欢迎页/Hub |
| **联络**（`tab-pinned`，`agentId = __companion__`） | 固定在滚动区外、**待办左侧** | 常驻不可关闭，点击激活 `__companion__` tab；IM / Watch `talk_to_user` 消息均路由到此 tab |
| **待办**（`tab-pinned` 伪 Tab） | 固定在**联络右侧**、新建按钮之前 | 非 Agent 会话；点击 `openTodos()` 主区渲染 `TodoPanel`；与 `TODO.json` / Agent `todo_*` 共用真相源（见 `skills/todo/SPEC.md`） |
| **新建 +**（`btn-new-tab`） | 最右端 | 点击 `handleNewAssistant()` 新建一个**空白独立助手 tab**（`createAssistantTab({ isPromoted: true })`，直接进 Tab 栏并激活，不走 Hub 焦点）；下拉菜单可选新建终端/SSH |

`displayedTabs` 同时排除：
1. 未提升的本地助手（`!tab.isRemote && !tab.isPromoted`）
2. `__companion__` tab（单独固定渲染）

`ensureCompanionTab()` 在 `initializeApp()` 最早调用，保证 `__companion__` tab 在整个 session 生命周期内始终存在。`closeTab` 对 `__companion__` 进行保护，永远返回 false。

**渲染与历史恢复**：联络 tab 走专属的 `CompanionWorkbench → AiPanel`（`kind='companion'`，与 assistant 平级；**只含聊天，无产出物面板/历史侧栏**，契约见 `workbench/companion/SPEC.md`），样式与普通助手一致且可从桌面直接续聊。IM/Gateway/桌面/Watch `talk_to_user` 的步骤都以 `agentId = __companion__` 通过标准 `agent:step` 流入同一会话。重启后联络 tab 为空时，`useAgentMode` 挂载阶段调 `history.getCompanionMergedView()` 取后端 `Companion.getMergedViewRecord()` 产出的合并视图 record（最近 N 条 companion record 的 steps 按时间升序拼接，`id`/`timestamp` 成对取最新一条以对齐续聊上下文；带 await 前后双重空检查防覆盖 live steps）；合并逻辑真相源在后端 `electron/services/conversation/companion.ts`，前端不再自拼。后端会话连续性由持久命名 Agent 自身的 `restoreFromHistory`/`restoreRecentTaskMemory` 负责。<br/>**已知局限**：仅能恢复带 `agentKey` 的记录（2026-06-21 引入字段之后产生的）；更早的联络对话与普通助手任务在历史里无字段可区分，无法回填，不出现在联络 tab。

---

## 二、Tab 分类规则（⚠️ 新增功能必读）

所有 `TerminalTab` 按以下规则分为三类：

### A. TabBar 可见 Tab（`displayedTabs`）

出现在顶部 Tab 栏（滚动区），全屏独占主区：

| 类型 | 条件 |
|---|---|
| 终端 Tab | `tab.type === 'local'` 或 `'ssh'` |
| 已提升助手 | `tab.type === 'assistant' && tab.isPromoted === true && !tab.isRemote` |
| 远程助手（非联络） | `tab.type === 'assistant' && tab.isRemote === true && tab.agentId !== '__companion__'` |

### B. 联络常驻 Tab（固定在 TabBar，不进入滚动区）

```
tab.agentId === '__companion__'
```

由 `COMPANION_TAB_AGENT_ID` 常量标识，在 TabBar 中单独渲染于 `tab-pinned`，不可拖拽、不可关闭。

### C. Hub 会话（不在 TabBar）

不在 Tab 栏，由侧栏管理：

| 条件 |
|---|
| `tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted` |

**判断公式（TabBar 过滤逻辑）**：
```
isDisplayed = !(tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted)
              && tab.agentId !== '__companion__'
```

---

## 三、视图状态机

前端主区的显示状态由两个 Store 字段决定：

```
terminalStore.activeTabId          // TabBar 可见 tab 的 id（空字符串 = 无）
terminalStore.hubFocusedAssistantTabId  // Hub 当前聚焦会话的 tab id（空字符串 = 无）
```

### 状态优先级（从高到低）

```
1. 覆盖层（觉醒/设置/智能巡检）— 叠加在所有状态上，优先关闭
2. activeTabId 非空 → 全屏展示该 Tab（终端/提升助手/远程助手），侧栏隐藏
3. activeTabId 为空 && hubFocusedAssistantTabId 非空 → Hub 焦点模式（欢迎页 + 助手对话叠加），侧栏可见
4. activeTabId 为空 && hubFocusedAssistantTabId 为空 → 欢迎页，侧栏可见
```

### 关键 computed（`App.vue`）

```ts
// 主区当前渲染的 tab（activeTab 优先，否则是 Hub 焦点会话）
activeSurfaceTabId = activeTabId || hubFocusedTab?.id || ''

// 欢迎页：没有任何 surface tab 时显示
showWelcomePage = !showSmartPatrol && !activeSurfaceTabId

// 侧栏：activeTabId 为空时常驻（Hub 视图始终可见）
showRecallSidebar = !activeTabId && !showSmartPatrol && !isSteamBuild
```

---

## 四、侧栏（RecentConversationsPanel）规则

### 可见性

`showRecallSidebar = !activeTabId`（有 TabBar 可见 Tab 时隐藏，Hub 视图时常驻）

### 列表数据来源

两路合并，自动去重：

| 来源 | 说明 |
|---|---|
| `liveSessionSummaries`（computed from `terminalStore.tabs`） | 已启动但尚未落盘的进行中会话，显示在列表最前面；对话完成后由 summaries 接管，无重复 |
| `summaries`（后端 `history.listAgentSummaries`） | 已完成对话；`agent.onComplete` / `agent.onError` 时静默刷新 |

**实时会话条件**（出现在 liveSessionSummaries）：
```
tab.type === 'assistant' && !tab.isRemote && 
tab.agentState.userTask 非空 && 
tab.agentState.sessionId 非空 && 
sessionId 不在 summaryById 中（未落盘）
```

### 活跃高亮规则

| 状态 | 高亮方式 |
|---|---|
| Hub 焦点会话（当前可见）| 行背景高亮 + hover 时文字也高亮 |
| 已提升为独立 Tab | 显示「独立 tab」图标 |
| 后台运行中（用户看不见）| 显示运行中动画图标 |
| 后台需要确认（用户看不见）| 显示 attention 图标 |

**规则：当前用户正在看的会话（Hub 焦点 / 已提升活跃 tab）不显示运行中/attention 图标**，因为用户已经看到了。

### 点击行为

1. `findTabByHistoryId(summary.id)` 找到现有 tab  
   - 本地未提升助手会话（`type==='assistant' && !isPromoted && !isRemote`）→ `focusHubConversation`（Hub 焦点，侧栏保留）  
   - 其余（终端 tab / 已提升独立 Tab / 远程助手）→ `setActiveTab`（激活该 Tab）  
2. 未找到 tab → 从历史加载 `openHistoryConversation(record)`

### 另开一聊（Fork）

`forkToAssistantTab` 创建的新会话**继承源会话的呈现形态**：

| 源会话 | 新分支 |
|---|---|
| Hub 侧栏会话（`!isPromoted`） | `focusHubConversation`：留在 Hub，侧栏保留 |
| 已提升独立 Tab（`isPromoted`） | `promoteConversationToTab`：新 Tab 出现在 Tab 栏 |
| 终端 Tab 内 AI 面板 | 默认走 Hub（`focusHubConversation`） |

**禁止**对 Hub 会话 fork 后直接 `activeTabId = newTabId`——会导致侧栏隐藏且 Tab 栏也不显示该会话（悬空面板）。

侧栏即时可见：`restoreAgentHistory` 必须写入 `agentState.userTask`（`liveSessionSummaries` 依赖此字段；fork 落盘前靠实时列表展示，落盘后由 `summaries` 接管）。

**会话标题稳定**：`agentState.userTask` = 首条 user_task（与 HistoryService `record.userTask` 一致）。`clearAgentState(preserveSession)` 与 `setAgentRunning` 均不得覆盖已有标题，避免侧栏在运行中显示当前输入、完成后又跳回。

### 搜索与分组

- 搜索匹配：`userTask` + 用户自定义标题（`configStore.getConversationDisplayTitle`），不区分大小写
- 分组：按对话结束时间（`timestamp + duration`）倒序，按日期段分为"今天 / 昨天 / 具体日期"组
- 实时会话（liveSessionSummaries）始终排在所有历史条目前面，不受日期分组约束
- 置顶（pinned）会话单独提前展示，不进入日期分组

### 删除行为

| 场景 | 处理方式 |
|---|---|
| 已提升为独立 Tab | 阻止删除，提示用户先关闭 Tab |
| 实时会话（liveSession，尚未落盘）| 确认后只关闭 Tab（`closeTab`），不调 `history.deleteAgentRecord` |
| 已完成历史记录 | 确认后调 `history.deleteAgentRecord` + 清理 Hub 焦点 Tab（若存在）|

### 右键菜单

| 操作 | 行为 |
|---|---|
| 在新标签页中打开 | `promoteConversationToTab`（已有 tab 直接提升；无 tab 则先加载历史再提升）|
| 重命名 | 写入 `configStore` 自定义标题（以 summary.id 为 key） |
| 置顶 / 取消置顶 | `configStore.togglePinConversation` |
| 删除 | 见删除行为表格 |

---

## 五、新对话流程

```
欢迎页 Composer 提交 / TabBar「+」按钮
  └→ goToHome()（清空 activeTabId + hubFocusedAssistantTabId）
      欢迎页出现，输入框自动聚焦

用户在 Composer 输入内容并提交
  └→ createAssistantTab({ activate: false })  // 不激活，不进 TabBar
      focusHubConversation(newTabId)           // Hub 焦点，侧栏保留
      会话立即出现在侧栏（liveSessionSummaries）
      Agent run 发起，AiPanel 展示进行中状态
```

---

## 六、后台任务（Watch / Gateway）规则

**规则：后台任务不得自动切换用户视图。**

Watch 触发、Gateway 远程任务、IM 消息等触发的助手任务：
- 静默注入步骤到对应助手 tab（`addAgentStep` 但不激活）
- 不调用 `setActiveTab` / `focusHubConversation`
- 任务完成后通过 Toast 通知引导用户主动查看
- 侧栏 attention 图标（用户不在看该会话时）引导导航

违反此规则的改动会打断用户当前工作，严禁。

---

## 七、会话提升与降级

### 提升（Hub → 独立 Tab）

触发：侧栏右键「在新标签页中打开」
```
tab.isPromoted = true
hubFocusedAssistantTabId = ''（清空 Hub 焦点）
setActiveTab(tabId)（激活独立 Tab）
```
- 提升后豁免 LRU 淘汰
- Tab 栏出现该会话

### 降级（关闭独立 Tab）

关闭已提升 Tab 时：
```
tab.isPromoted = false（降级，非删除）
tab 从 TabBar 消失，但仍存在于 terminalStore.tabs
侧栏可重新打开该会话（历史记录仍在）
```

---

## 八、资源管理

### LRU 会话池

- **上限**：`HUB_SESSION_LIMIT = 5`（Hub 内非提升助手 tab）
- **触发**：`focusHubConversation` 时自动淘汰
- **豁免**：正在运行（`isRunning`）/ 待确认（`pendingConfirm`）/ 已提升（`isPromoted`）
- **淘汰策略**：按 `lastFocusedAt` 升序，最久未聚焦 & 空闲优先

### 并发软上限

- **上限**：`MAX_CONCURRENT_AGENTS = 8`
- **性质**：软限制（警告，不阻止手动操作），主要防 Watch/IM 批量涌入
- **`isAtConcurrencyLimit` computed**：超出时可用于提示 UI

---

## 九、退出确认计数

退出时弹框中"有意义的开放 tab"计数规则：

```
有意义 = t.type !== 'assistant'          // 终端 tab
        || t.isRemote                    // 远程助手
        || t.isPromoted                  // 已提升助手
        || (t.type === 'assistant' 
            && !t.isRemote 
            && !t.isPromoted 
            && t.agentState?.isRunning)  // Hub 中正在运行的助手
```

未提升、未运行的 Hub 会话不计入（用户随时可从历史恢复，无丢失风险）。

---

## 十、关键 Store Actions 速查

| Action | 作用 |
|---|---|
| `focusHubConversation(tabId)` | Hub 焦点切到指定会话，触发 LRU |
| `clearHubFocus()` | 清空 Hub 焦点，回欢迎页 |
| `goToHome()` | 清空 activeTabId + hubFocusedAssistantTabId，完全回欢迎页 |
| `promoteConversationToTab(tabId)` | 提升为独立 Tab |
| `openHistoryConversation(record)` | 从历史记录恢复会话到 Hub |
| `createAssistantTab({ activate })` | 创建新本地助手 tab；`activate: false` = 不进 TabBar |
| `setActiveTab(tabId)` | 激活 TabBar 可见 Tab |
| `closeTab(tabId, force?)` | 关 tab；非提升助手 = 降级；提升/终端 = 销毁 |

---

## 十一、常见错误与防范

| 错误 | 后果 | 防范 |
|---|---|---|
| 后台任务调用 `setActiveTab` / `focusHubConversation` | 打断用户当前操作 | 后台路径只调 `addAgentStep` |
| 为 Hub 会话创建 tab 时传 `activate: true` | 会话意外出现在 TabBar | 本地助手 tab 创建一律 `activate: false` |
| 修改 Cmd+W 逻辑 | 影响全局快捷键行为 | 见 `src/APP_SPEC.md`，Cmd+W 是全局规则，不属于 Hub 模型 |
| 侧栏 attention 显示条件不过滤当前可见会话 | 干扰用户正在看的对话 | attention 图标仅对后台会话有效 |
| 删除实时会话时调用 `history.deleteAgentRecord` | 接口报错（记录未落盘）| 先检查 `liveSessionSummaries`，实时会话只关 tab |
