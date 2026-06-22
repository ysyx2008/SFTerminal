# App.vue 全局交互规则 SPEC

> Last verified: 2026-06-20  
> 涵盖范围：`src/App.vue` 中的全局快捷键、覆盖层、窗口生命周期相关规则。  
> Hub 助手模型的交互规则见 `src/workbench/assistant/HUB_SPEC.md`。

---

## 一、全局快捷键清单

所有快捷键在 `handleGlobalKeydown` 中按以下顺序处理（**有顺序依赖，不可随意调换**）：

| 快捷键 | 默认值 | 行为 | 是否可自定义 |
|---|---|---|---|
| 新建助手对话 | `Cmd+T`（可改） | `terminalStore.goToHome()` | ✅ |
| 新建本地终端 | `Cmd+Shift+T`（可改） | `terminalStore.createTab('local')` | ✅ |
| ESC | 固定 | 关闭 SSH 凭证侧栏（须让路给模态弹窗） | ❌ |
| Ctrl/Cmd+W | 固定 | 见第二节决策树 | ❌ |
| 分屏横向 | `Cmd+D`（可改） | `splitTerminal('horizontal')`，**仅终端 tab** | ✅ |
| 分屏纵向 | `Cmd+Shift+D`（可改） | `splitTerminal('vertical')`，**仅终端 tab** | ✅ |
| 关闭窗格 | `Cmd+Shift+W`（可改） | 关闭激活分屏窗格，**仅已分屏终端 tab** | ✅ |

**分屏快捷键约束**：`tab.type === 'assistant'` 时整组分屏快捷键不生效（`handleSplitShortcut` 直接 return）。

**Windows Alt 键**：单独按下并松开 Alt（不与其他键组合）→ 弹出汉堡菜单（模拟 Windows 系统菜单栏行为）。全屏 overlay 打开时不响应，避免菜单位置异常。

---

## 二、Cmd+W（关闭/隐藏）决策树

`handleCloseShortcut` 的完整优先顺序，**从上到下依次判断，命中即止**：

```
1. 有全屏覆盖层（觉醒 / 设置 / 智能巡检）
      └→ 关闭覆盖层，结束

2. 有 activeTab（TabBar 可见 Tab）
   ├─ tab.agentId === '__companion__'（联络常驻 tab，不可关闭）
   │     └→ goToHome()，退回欢迎页，不关窗口
   ├─ tab.type === 'assistant' && !isPromoted && !isRemote
   │     （理论兜底，正常流程不应出现此情况）
   │     └→ 隐藏窗口
   └─ 终端 Tab / 已提升助手 Tab / 其他远程助手 Tab
         └→ closeTab(activeTab.id)，不关窗口

3. 无 activeTab，有 hubFocusedAssistantTabId（Hub 焦点模式）
      └→ goToHome()，退回欢迎页（侧栏保留），不关窗口

4. 无 activeTab，无 Hub 焦点（欢迎页）
   ├─ hasDisplayedTabs（有终端/提升/远程 Tab）→ 不做任何事
   └─ 无任何真实 Tab → 隐藏窗口（window.close）
```

**修改此逻辑时必须保证覆盖层始终第一优先，且所有新增的 Tab 类型都在第 2 步内明确处理。**

---

## 三、macOS ⌘Q 防误触

主进程检测 ⌘Q 事件后，不立即退出，而是先向渲染进程发送 `quit.onToast` 信号：
- 渲染进程显示顶部 Toast 提示条（`quitToastVisible`）
- 用户**在提示条消失前再次按 ⌘Q** → 主进程才真正执行退出
- 提示条自动消失后，再次按 ⌘Q 重新走同一流程

**目的**：防止用户在终端内操作时误触 ⌘Q 退出整个应用。  
**实现**：`window.electronAPI.quit.onToast` IPC 事件 + `quitToastVisible` ref。

---

## 四、覆盖层（全屏 UI）优先级

以下覆盖层互斥，打开任意一个后 Cmd+W 只关该覆盖层：

| 覆盖层 | 控制变量 |
|---|---|
| 觉醒（Awaken）| `showAwaken` |
| 设置面板 | `showSettings` |
| 智能巡检 | `showSmartPatrol` |

覆盖层关闭后，主区状态（activeTabId / hubFocusedAssistantTabId）不变。

---

## 五、退出确认计数

应用退出时（`window.electronAPI.window.requestTerminalCount` IPC），向主进程上报"有意义的开放会话数"：

```
有意义 = tab.type !== 'assistant'           // 终端 Tab（local/ssh）
        || tab.isRemote                      // 远程助手 Tab
        || tab.isPromoted                    // 已提升的本地助手 Tab
        || (tab.type === 'assistant'
            && !tab.isRemote
            && !tab.isPromoted
            && tab.agentState?.isRunning)    // Hub 中正在运行的助手会话
```

未提升、未运行的 Hub 会话**不计入**（随时可从历史恢复，无丢失风险）。

---

## 六、视图状态说明

> 详细视图状态机（Hub 焦点 / 欢迎页 / 侧栏可见性等）见  
> `src/workbench/assistant/HUB_SPEC.md` 第三节。

`App.vue` 中关键 computed 一览：

```ts
// 主区当前渲染的 tab
activeSurfaceTabId = activeTabId || hubFocusedTab?.id || ''

// 欢迎页：没有任何 surface tab 时显示
showWelcomePage = !showSmartPatrol && !activeSurfaceTabId

// 侧栏：activeTabId 为空时常驻（Hub 视图始终可见）
showRecallSidebar = !activeTabId && !showSmartPatrol && !isSteamBuild

// Tab 栏"有意义"tab 存在（决定 Cmd+W 最后一步是否隐藏窗口）
hasDisplayedTabs = tabs.some(t => !(t.type === 'assistant' && !t.isRemote && !t.isPromoted))
```
