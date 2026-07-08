# AiPanel 渲染规则 SPEC

> Last verified: 2026-07-03（proactive_notice step、talk_to_user 内联渲染）  
> 文件：`src/components/AiPanel.vue`  
> 职责：将 agentTaskGroups 渲染为可交互的对话流 UI，管理滚动、确认框、输入框等。

---

## 一、渲染层次结构

```
AiPanel
├── DynamicScroller（vue-virtual-scroller v3，虚拟列表）
│   ├── #before slot
│   │   └── ai-welcome（空会话欢迎页）
│   └── VirtualItem（每个可见行）
│       ├── user_task（用户消息气泡）
│       ├── thinking（思考块）
│       ├── message（AI 回复）
│       ├── tool_call / tool_result（工具调用）
│       ├── user_supplement（运行中追加的用户消息）
│       ├── proactive_message（历史格式：user_task __proactive__ + final_result）
│       ├── proactive_notice（talk_to_user 内联主动通知，非分组边界）
│       └── ...
├── PendingConfirmCard（需要确认时叠加在底部）
├── PendingSecureInputCard（需要密钥输入时）
└── AiComposer（输入框）
```

---

## 二、步骤类型 → 视觉组件映射

| step.type | 渲染组件 | 备注 |
|---|---|---|
| `user_task` | 用户气泡（UserTaskBubble） | proactive/onboarding 不渲染 |
| `thinking` | ThinkingBlock（折叠块）| 流式时展开，完成后可折叠 |
| `message` | MarkdownRenderer + ThinkingBlock | 含思考块时先渲染思考折叠块再渲染正文 |
| `tool_call` | ToolCallCard | 调试模式 OFF 时隐藏"无用户必看产出"的成功工具调用 |
| `tool_result` | ToolResultCard | 同上 |
| `final_result` | FinalResultCard | 只在失败/中断时独立渲染；正常完成时 message step 已含全文 |
| `error` | ErrorCard | 红色错误提示 |
| `user_supplement` | 用户补充消息气泡 | 按 steps 时间顺序渲染，不提前到 user_task 之后 |
| `proactive_notice` | assistant 气泡（markdown） | talk_to_user 注入；内联于任务流，不关闭当前 group |
| `confirm` | 不进入 steps，由 pendingConfirm 管理 | - |
| `waiting` / `asking` | 等待状态指示器 | - |

### tool_call 可见性规则

调试模式 OFF 时，以下 tool_call/result 对**隐藏**：
- `tool_call` 执行成功（有对应 tool_result）且不含用户必看信息

调试模式 ON 时全部显示。

---

## 三、ThinkingBlock（思考块）渲染

思考内容以特定 HTML 结构内嵌在 `message` step 的 `content` 中：

```html
<details open>
  <summary>🤔 Thinking…</summary>
  <blockquote>
    [思考内容，流式追加]
  </blockquote>
</details>

[正文内容]
```

`parseThinking(content)` 工具函数从 `content` 中提取：
- `thinking`：思考块全文（用于 ThinkingBlock 渲染）
- `body`：正文部分（用于 MarkdownRenderer）

**流式态**：`details open` → ThinkingBlock 展开；完成后可由用户折叠。  
**虚拟列表限制**：DynamicScroller 会在 ThinkingBlock 滚出视口时 unmount，`open` 状态会被重置。ThinkingBlock 内部通过 `keepAlive` 机制（实际是自身 ref）保存折叠状态，滚回时恢复。

**「正在准备...」**：仅由左侧 ThinkingBlock 单行呈现（无居中 fallback）。后端 initial thinking step 到达前，`useAgentMode.flattenedItems` 在步骤流末尾注入虚拟 step（`type='thinking'` + `isStreaming=true`）；step 从 `thinking` 变为 `message` 但 content 尚无 🤔 时，`getMessageStepPresentation` 仍保持 ThinkingBlock 流式行，避免切换空白。

---

## 四、自动滚底行为

| 场景 | 行为 |
|---|---|
| 新步骤到达（onStep） | `scrollToBottomIfNeeded`（智能：用户向上翻阅时不强制滚底） |
| 需要确认（onNeedConfirm）| `scrollToBottom`（强制，两次，间隔 150ms） |
| runAgent 发起时 | `scrollToBottom`（强制，确保用户任务气泡可见） |
| 用户主动上翻 | 停止自动滚底，列表区域**底部中央**显示「新消息↓」悬浮按钮 |
| 用户点击「新消息↓」 | `scrollToBottom`（强制），恢复自动跟随 |

**智能滚底判定**（`scrollToBottomIfNeeded`）：判断用户是否处于底部区域（`SCROLL_THRESHOLD = 100px`，即 `scrollHeight - scrollTop - clientHeight < 100`），在此范围内则自动滚底，否则仅显示「新消息↓」提示。阈值设为 100px 而非 0，是为了容纳虚拟列表高度测量的误差和动态内容渲染的抖动。

**已知行为**：上滚后触发「新消息」气泡的阈值要合理（不能上滚一点点就亮），防止用户滚动查看历史时频繁被打断。

---

## 四·补、ResizeObserver 滚动补偿策略

> 文件：`src/composables/useAgentMode.ts`
> 为什么单独成节：这是滚动 bug 反复回归的重灾区（6 次提交、3 次回归）。补偿逻辑若不看「增长来源相对视区的位置」，必然在「上方 item 实测高度修正」和「下方流式 item 长高」之间混淆——两者对 `scrollTop` 的正确行为恰好相反。

### 背景：为什么需要补偿

`DynamicScroller`（vue-virtual-scroller）的 wrapper `.vue-recycle-scroller__item-wrapper` 高度会因 item 内容变化而变。`ResizeObserver` 监听 wrapper 高度，在 `wrapperDelta = newHeight - prevHeight` 非零时触发补偿逻辑，决定是否调整 `scrollTop` 以维持视区锚点。

### 两个关键判定维度

1. **模式（mode）**：`shouldFollowResize()` 返回 true → 跟底态（用户在底部跟随新内容）；false → 阅读态（用户上滚离开底部）。
2. **增长来源相对视区的位置**（仅阅读态需要细分）：
   - **视区上方**：如历史 item 从估算高度 → 实测高度（首次滚动时虚拟列表测量）。此时应 `scrollTop += wrapperDelta` 维持视区，否则内容会漂。
   - **视区下方**：如新 item append、正在流式的最后一个 step 项高度增长。此时浏览器默认保持 `scrollTop` 不变即正确锚定，**补偿反而把视区下推 → 视区内容相对上移 → 画面一行一行向上跳**。

### 补偿策略表

| 模式 | wrapperDelta 区间 + 条件 | 副作用 |
|---|---|---|
| following（跟底） | ≤ 0 且 > -MAX_FLIP | 钉新底 + guard（防 clamp 漂移） |
| following | ≤ -MAX_FLIP | 不动（防图片加载震荡） |
| following | > 0 且 suppress 窗口内 或 ≥ MAX_FLIP | 钉新底 + guard（硬切，无 FLIP） |
| following | > 0 且小增长 | 钉新底 + guard + FLIP 平滑 |
| reading（阅读） | ≤ 0 | 不动（浏览器自然 clamp） |
| reading | (0, MAX_FLIP) 且 scrollTop < THRESHOLD | 不动（顶部附近，wrapper 增长不影响顶部视区） |
| reading | (0, MAX_FLIP) 且 scrollTop≥TH 且增长来自视区下方 | **不动**（浏览器保持 scrollTop 不变即正确） |
| reading | (0, MAX_FLIP) 且 scrollTop≥TH 且增长来自视区上方 | `scrollTop += delta` 维持视区锚定 |
| reading | ≥ MAX_FLIP | 不动（虚拟列表重排，避免一次性推走很多） |

- `TH` = `SCROLL_THRESHOLD`（100px）；`MAX` = `MAX_FLIP_DELTA`（600px）
- `suppress` 窗口 = `scrollToBottom` 后短暂 200ms（`Date.now() < suppressFlipUntil`），避免补偿与强制滚底打架
- `suppress` 窗口（另一个触发点）= onStep 收到首个 streaming message step 且 `agentState.steps` 里仍存在 `placeholder='startup'` 占位时，先**乐观移除占位**（避免「占位 + 新 message」两张卡片同时渲染的中间态闪现），再设 `PLACEHOLDER_SWITCH_SUPPRESS_MS`（300ms）窗口。覆盖后端紧接着的 `removeStep(initial 占位)` IPC（幂等跳过）+ wrapper 高度变化，让两张 ThinkingBlock 单行卡片同位硬切而非"从下往上滑一下"。窗口结束后后续流式 chunk 恢复走 FLIP 不受影响。

### 「增长来源相对视区位置」如何判定

**实现**：`isGrowthBelowViewport(el, itemsAppended)` 函数（`useAgentMode.ts`）。
1. `itemsAppended === true`（`flattenedItems.length` 增加）→ 新 item append，必在下方，直接返回 true
2. AI 运行中或停止后 300ms grace 期内 → 流式输出在下方，返回 true（兜底，覆盖 `getItemOffset` 尚未就绪的初始帧）
3. 用 `scroller.getItemOffset(lastIndex)` 取最后一个 item 顶距 wrapper 顶的距离，与视区底（`scrollTop + clientHeight`）比较，最后一个 item 在视区下方则返回 true

> 优先用显式判定（步骤 3），代理指标（步骤 1/2）作快速短路和兜底。当 `getItemOffset` 不可用时回退到代理指标——此时已知边界：AI 运行时若上方历史 item 真的发生实测高度修正会被误判为下方增长而漏补偿，历史 item 通常在打开对话时已实测完成，运行时少见。

### 改这块代码前必读

1. **先判模式，再判增长位置**。两个维度缺一不可——只看 `wrapperDelta` 数值/符号会混淆上方/下方增长。
2. **不要在 `applyReadingResize` 里调 `guardAfterAutoScroll`**：会把 `stickyFollowBottom` 设回 true 破坏阅读态（回归 42ff929a / 971f19a6 的隐患根源）。
3. **不要设 `skipScrollUpdate`**：补偿是即时一次性，吞 scroll 事件会漏用户后续手动滚动。
4. **改完更新本节策略表**：任何新增/修改分支条件，同步更新上面的表格。

---

## 五、空会话欢迎页（ai-welcome）

显示条件：`!isAgentRunning && !agentUserTask && agentTaskGroups.length === 0`

独立助手（isStandaloneAssistant）时显示能力示例网格：
- 示例池 25 条，首屏精选 8 条
- 「换一批」按钮洗牌重抽（不重复 Fisher-Yates）
- 点击示例 → 填入 composer 输入框，不直接发送

终端 tab 下展示简化版（无示例网格，只有基础说明文字）。

---

## 六、WelcomeChatComposer 设计规则

> 文件：`src/components/WelcomeChatComposer.vue`

### 输入框自动聚焦

- `onMounted`：若 `props.active === true`，立即聚焦
- `watch(props.active)`：切回欢迎页（active 变 true）时自动聚焦
- 目的：用户每次来到欢迎页不需要手动点击输入框

### Composer 提交流程（handoff）

```
用户提交
  │
  ├─ createAssistantTab({ activate: false })          // 创建新 tab
  ├─ transferUploadedDocs(WELCOME_ID, tabId)          // 转移文档附件
  ├─ setPendingComposerHandoff(tabId, { msg, imgs })  // 存储待发内容
  ├─ markAssistantSkipOnboarding(tabId)               // 跳过引导
  └─ focusHubConversation(tabId)                      // 切换到新会话

AiPanel（新 tab 激活后）检测到 handoff
  └─ consumePendingComposerHandoff → runAgent         // 消费并发起 run
```

### 草稿持久化

- 用户在欢迎页 Composer 输入但未发送时，离开欢迎页前自动保存草稿（文字 + 图片）
- 回到欢迎页时恢复草稿，聚焦输入框
- 发送成功后清除草稿（`clearWelcomeComposerDraft`）

### 输入框设计

- 两行输入框（默认单行，有内容时自动扩展到两行，再多换行改为 textarea 滚动）
- 位置固定：不随内容扩张向上位移（欢迎页 logo 等元素不上下跳动）

---

## 七、多轮对话的步骤保留

`clearAgentState(tabId, keepSteps=true)` 每次新任务发起时调用，**保留**已有的 steps。

效果：同一 tab 的多次对话任务都叠加在同一个步骤列表中，`agentTaskGroups` 将它们按 `user_task` 分隔，形成完整的对话历史视图。

清除 steps 的时机：
- `closeTab`（关闭 tab）
- `restoreAgentHistory`（从历史记录恢复，会用历史 steps 替换当前 steps）
- `clearAgentState(tabId, false)`（显式清除，较少使用）
