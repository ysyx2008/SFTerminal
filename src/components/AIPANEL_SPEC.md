# AiPanel 渲染规则 SPEC

> Last verified: 2026-07-13（迁移 virtua Virtualizer，移除 FLIP 补偿）  
> 文件：`src/components/AiPanel.vue`  
> 职责：将 agentTaskGroups 渲染为可交互的对话流 UI，管理滚动、确认框、输入框等。

---

## 一、渲染层次结构

```
AiPanel
├── .ai-messages（滚动容器，messagesRef）
│   ├── WelcomePanel（空会话欢迎页）
│   ├── HistorySearchModal
│   └── Virtualizer（virtua，虚拟列表）
│       └── VirtualItem（每个可见行）
│           ├── user_task（用户消息气泡）
│           ├── thinking（思考块）
│           ├── message（AI 回复）
│           ├── tool_call / tool_result（工具调用）
│           ├── user_supplement（运行中追加的用户消息）
│           ├── proactive_message（历史格式：user_task __proactive__ + final_result）
│           ├── proactive_notice（talk_to_user 内联主动通知，非分组边界）
│           └── ...
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
**虚拟列表限制**：Virtualizer 会在 ThinkingBlock 滚出视口时 unmount，`open` 状态会被重置。ThinkingBlock 内部通过 `keepAlive` 机制（实际是自身 ref）保存折叠状态，滚回时恢复。

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

## 四·补、虚拟滚动与跟底策略（virtua）

> 文件：`src/composables/useAgentMode.ts`  
> 2026-07-13 起：消息列表从 `vue-virtual-scroller`（DynamicScroller）迁移到 [`virtua`](https://github.com/inokawa/virtua) 的 `Virtualizer`。

### 为什么换库

DynamicScroller 是回收式虚拟列表，动态高度 + 流式增长场景下需要自建 ResizeObserver / FLIP 补偿（曾 6 次提交、3 次回归）。virtua 内置 dynamic size measurement 与 scroll position adjustment，跟底态跳动由库处理。

### 当前滚动职责划分

| 职责 | 谁负责 |
|---|---|
| 动态高度测量 / 上方 item 高度修正时的视区锚定 | virtua 内置 |
| 跟底态：新内容到达 / 最后一项流式长高时钉底 | `stickyFollowBottom` + `animateFollowBottom` / `pinFollowBottom`；`followResizeObserver` 监听 Virtualizer 根高度 |
| 跟底态：新内容上移的平滑滑动 | `animateFollowBottom`：`scrollTop` 用 `cubic-bezier(0.32, 0.72, 0, 1)` 追底；中途长高保持插值进度 p 重算 from/to（不重置、不硬切），字快只抬高目标 |
| 阅读态：用户上滚后不拽回底部，亮「新消息」 | `updateScrollPosition` / `userScrolledAway` / `hasNewMessage` |
| 切 tab / 恢复历史的精确视口位置 | `aiScrollAnchor`（item id + offset）+ `scrollToIndex` |
| 历史冷加载视觉抖动 | `isHistoryScrollPending`（opacity:0 → scrollHeight 稳定后淡入） |
| 容器宽度变化导致的 reflow | `installContainerWidthObserver`（跟底时主动 `scrollToBottom`） |

### 已删除（勿再引入）

- `applyFollowingResize` / `applyReadingResize` / `isGrowthBelowViewport`（阅读态 scrollTop 补偿表）
- `aiScrollCache` / `restoreCache`（virtua CacheSnapshot 结构不同且不保证跨版本）
- `getItemSizeDeps` / `DynamicScrollerItem`（virtua 自动重测，无需手动 size-dependencies）

### 跟底动画约束

1. **用 `scrollTop` ease-out 追底，禁止 translateY FLIP**——FLIP 在流式 chunk 打断时会先瞬间下移再上推，观感像回弹。
2. **`doScrollIfNeeded` 禁止先硬钉底**——会把 gap 吃成 0，动画消失。主动跳底（`scrollToBottom`）才硬切。
3. **中途长高保持插值进度 p 重算 from/to**（`retargetFollowAnimation`），禁止把 t 重置回 0；时间不够只延长 duration。
4. **仅 gap ≥ `MAX_FOLLOW_HARD_CUT`（2400）才硬切**；普通流式再快也走动画。`scrollTop` 赋值用 `Math.max` 保证单调不减。
5. **曲线只用 `cubic-bezier(0.32, 0.72, 0, 1)`**，禁止弹簧/过冲。
6. **用户上滚必须 `cancelFollowScrollAnimation`**。

### 改这块代码前必读

1. **跟底意图用 `stickyFollowBottom`，不要只靠瞬时 `checkIsNearBottom()`**——虚拟列表 scrollHeight 异步修正时会误判。
2. **阅读态禁止 `guardAfterAutoScroll` / 禁止在 followResizeObserver 里处理阅读态**——会把 sticky 设回 true 或把用户从阅读位拽走。
3. **跨视口文本全选仍是虚拟列表通病**——virtua 亦不解决；后续可另做自定义选择或加大 bufferSize。

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
