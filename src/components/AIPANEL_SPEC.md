# AiPanel 渲染规则 SPEC

> Last verified: 2026-06-20  
> 文件：`src/components/AiPanel.vue`  
> 职责：将 agentTaskGroups 渲染为可交互的对话流 UI，管理滚动、确认框、输入框等。

---

## 一、渲染层次结构

```
AiPanel
├── DynamicScroller（vue-virtual-scroller v3，虚拟列表）
│   ├── #before slot
│   │   ├── agent-preparing-placeholder（运行中且无步骤时）
│   │   └── ai-welcome（空会话欢迎页）
│   └── VirtualItem（每个可见行）
│       ├── user_task（用户消息气泡）
│       ├── thinking（思考块）
│       ├── message（AI 回复）
│       ├── tool_call / tool_result（工具调用）
│       ├── user_supplement（运行中追加的用户消息）
│       ├── proactive_message（Watch 触发的主动消息）
│       └── ...
├── PendingConfirmCard（需要确认时叠加在底部）
├── PendingSecureInputCard（需要密钥输入时）
└── AiComposer（输入框）
```

---

## 二、agent-preparing-placeholder（正在准备）

**显示条件**（精确，必须同时满足）：

```
isAgentRunning &&
(
  agentTaskGroups.length === 0              // user_task 步骤尚未到达
  ||
  (
    agentTaskGroups[last].isCurrentTask &&  // 当前任务 group 存在
    agentTaskGroups[last].steps.length === 0  // 但 group 内还没有任何步骤
  )
)
```

**设计原因**：后端在发送 `user_task` 步骤和第一个 `thinking` 步骤之间，会同步执行 `restoreFromHistory()`（可能耗时数十毫秒）。这段时间内 `agentTaskGroups.length > 0` 但 `steps` 为空，如果只判断 `length === 0` 会出现短暂空白。第二个条件确保 placeholder 持续显示直到第一个步骤到达。

---

## 三、步骤类型 → 视觉组件映射

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
| `confirm` | 不进入 steps，由 pendingConfirm 管理 | - |
| `waiting` / `asking` | 等待状态指示器 | - |

### tool_call 可见性规则

调试模式 OFF 时，以下 tool_call/result 对**隐藏**：
- `tool_call` 执行成功（有对应 tool_result）且不含用户必看信息

调试模式 ON 时全部显示。

---

## 四、ThinkingBlock（思考块）渲染

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

---

## 五、自动滚底行为

| 场景 | 行为 |
|---|---|
| 新步骤到达（onStep） | `scrollToBottomIfNeeded`（智能：用户向上翻阅时不强制滚底） |
| 需要确认（onNeedConfirm）| `scrollToBottom`（强制，两次，间隔 150ms） |
| runAgent 发起时 | `scrollToBottom`（强制，确保用户任务气泡可见） |
| 用户主动上翻 | 停止自动滚底，顶部/底部均显示「新消息↓」按钮 |
| 用户点击「新消息↓」 | `scrollToBottom`（强制），恢复自动跟随 |

**智能滚底判定**（`scrollToBottomIfNeeded`）：判断用户是否在底部附近（`aiScrollNearBottom` state），是则滚底，否则仅显示新消息提示。

**已知行为**：上滚后触发「新消息」气泡的阈值要合理（不能上滚一点点就亮），防止用户滚动查看历史时频繁被打断。

---

## 六、空会话欢迎页（ai-welcome）

显示条件：`!isAgentRunning && !agentUserTask && agentTaskGroups.length === 0`

独立助手（isStandaloneAssistant）时显示能力示例网格：
- 示例池 25 条，首屏精选 8 条
- 「换一批」按钮洗牌重抽（不重复 Fisher-Yates）
- 点击示例 → 填入 composer 输入框，不直接发送

终端 tab 下展示简化版（无示例网格，只有基础说明文字）。

---

## 七、WelcomeChatComposer 设计规则

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

## 八、多轮对话的步骤保留

`clearAgentState(tabId, keepSteps=true)` 每次新任务发起时调用，**保留**已有的 steps。

效果：同一 tab 的多次对话任务都叠加在同一个步骤列表中，`agentTaskGroups` 将它们按 `user_task` 分隔，形成完整的对话历史视图。

清除 steps 的时机：
- `closeTab`（关闭 tab）
- `restoreAgentHistory`（从历史记录恢复，会用历史 steps 替换当前 steps）
- `clearAgentState(tabId, false)`（显式清除，较少使用）
