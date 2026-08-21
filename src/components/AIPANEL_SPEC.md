# AiPanel 渲染规则 SPEC

> Last verified: 2026-08-21（长任务过程折叠）  
> 文件：`src/components/AiPanel.vue`  
> 职责：将 agentTaskGroups 渲染为可交互的对话流 UI，管理滚动、确认框、输入框等。

---

## 设计目标

> **任务的过程收成一行（2026-08-21）**
>
> - **问题**：长任务过程很多，用户一般不需要看每一步；摊开全是工具卡，人要自己从里面猜「搞到哪了」。更糟的是"先摊开、做完再收"——步骤刚冒出来又消失，用户会下意识去追。
> - **成功标准**：
>   1. 一个任务在界面上只有两种东西：**它说给你听的话永远在外面**（对话主体），**它做事的过程永远收着一行**（附属）。**想也算过程**：一句话里"它先想了想"那截跟着收进那一行，外面只留它说出口的那句——对话流里不再夹着一排「思考完成 · 点击查看」；想看，点开那一行，思考就在它当时想的位置上。
>   2. 那一行从任务开始到结束**位置不动、行数不变，只换内容**——跑着的时候说它在忙什么并走秒，做完说这段做了什么、花了多久。不是"做完才收"，而是压根没展开过，所以没有任何东西冒出来又消失。
>   3. 跑着时那句"在忙什么"用**它自己刚写下的思考**，没有才退回动作分类。像隔着门喊一句"我在查上个月的账"，而不是报工具名。**只喊它已经写完的整句，且一句至少停留一会儿再换**——半句话跟着流一个字一个字地变，闪得看不清，等于没说。
>   4. **过程中某次工具失败收进去**——它试三次成了就是成了，试错是它的事；只有整件事没办成才告诉用户，那本来就是它给你的回话。
>   5. **要你动手的永远在外面**：确认危险命令、问你问题、等你输密码。这是唯一真正该打断你的东西。它交给你的产出（图表、搜索结果、主动发出的消息）同样在外面。
>   6. **形态始终一致**：任何任务都收，哪怕只跑了一步；新旧对话一个样。不存在有时收有时不收。
>   7. 点开任一行，原来的底稿都还在，顺序与它当时干活的顺序一致；想一直看全过程的人，可以在设置的「对话显示」里关掉这项简化。
>   8. **严格模式下一概不收**：选严格就是要盯着它每一步，这时候把过程收起来是跟用户对着干。宽松、自由才收。
> - **关键取舍**：不为折叠另写摘要——做了什么从工具调用数出来，在忙什么用它自己写下的话。视觉上刻意不加装饰：无左侧图标、无底色，左边缘与正文对齐，箭头在文字右侧紧跟；转环与箭头共用同一格，做完原地互换，文字一个像素都不动。展开走高度平滑撑开并以左竖线归组，收起不做动画。
> - **明确不做**：不另请模型写一句漂亮人话；不因此少记任何一步；调试模式仍看全部。顶部若有计划，计划还是任务地图，不跟过程抢位置。

> **运行中再说一句话：插入 vs 排队（2026-08-13）**
>
> - **问题**：任务进行时，用户可能想立刻改方向，也可能只是把下一件事先记下来、不想打断手头的事。以前只有前者。
> - **成功标准**：
>   1. 回车仍立即插入当前任务（现有「补充」）。
>   2. ⌘/Ctrl+回车把这句话排到当前任务结束之后，作为下一件新任务执行；排队的内容在输入框上方看得见、能删掉。
>   3. 当前任务停下（做完、失败、或用户点停止）后，按排队顺序一件一件做；关掉会话或丢掉队列则不再执行。
> - **关键取舍**：打断仍是默认——跟秘书说话是「我现在说、你现在听」。排队必须显式。换行仍是 Shift+回车，不拿来当第二种发送。
> - **不为排队加发送按钮（2026-08-18）**：排队只走快捷键，运行中输入框右下角仍只有一个按钮，两种做法写在输入框的提示文字和按钮浮层里。宁可鼠标用户晚一点发现这个功能，也不让常态界面变胖。
> - **队列长什么样（2026-08-18 / 08-20）**：排队好的内容在输入框上方**上下排开**，顶上一行浅字交代「排了几条、什么时候执行」——这句说明是必需的，光有条目会让人不知道那是什么。条目本身要最朴素：纯文本、不编号、过长折两行。每条右侧是图标操作（编辑、插入当前对话、删除），不写长文案；删除只在鼠标指到那一条时露出来。可以拖动调整先后顺序。
> - **排队中的话可以插入当前对话（2026-08-19）**：
>   - **问题**：话已经排进队列后，有时又想马上插进当前这场对话，以前只能删掉再重打一遍。
>   - **成功标准**：每条排队旁边有「插入当前对话」；点了之后这条从队列里拿掉，用和回车补充一样的方式追加进**当前这场还在跑的对话**；手头任务不停、不另起一轮；其余排队的还在，仍等当前任务结束后按顺序做；输入框里正在打的字不动。
>   - **关键取舍**：这是「插进当前这场」，不是立刻另开一件新任务，也不是先停掉手头再重发。用图标表达，不用听起来像「另开一轮」的文案。
> - **排队中的话可以改（2026-08-20）**：
>   - **问题**：排进去之后发现写错了、或想补附件，以前只能删掉重排。长文和附件也不适合在队列行里原地改。
>   - **成功标准**：
>     1. 点编辑图标，把这条（文字、图片、附件）填回输入框来改；队列里仍占着原来的位置（显示「编辑中」），改完保存后回到该位置，不是队尾。
>     2. 输入框里已经有字、图、附件或引用时，不允许开始编辑，要提示先发完或清掉。
>     3. 编辑进行中，输入框和普通打字明显区分（顶上有提示条、可取消）；这时回车和 ⌘/Ctrl+回车都是「保存回原位」；要插进当前对话仍用插入图标。
>     4. 保存时如果内容被清空（没字也没图/附件），这条从队列删掉。取消则原样恢复，输入框清空。
>   - **关键取舍**：不在队列行里原地改——长文和附件装不下。编辑占用输入框，所以必须和普通输入区分开，也必须拦住「输入框里已有东西」的冲突。
> - **明确不做**：不改 IM / 网关（那些仍是插入）；不做队列持久化；不把排队消息提前画进对话流；闲着的时候 ⌘/Ctrl+回车就是普通发送。

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
│           ├── folded_turn（已过去的过程：动作点数 + 它自己写下的结论）
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
| 跟底态：新内容上移的平滑滑动 | `animateFollowBottom`：每帧指数逼近 `scrollHeight - clientHeight`（`1-e^(-k·dt)`）；目标抬高只增加 remain，无 from/to 重定向，避免流畅中微跳 |
| 阅读态：用户上滚后不拽回底部，亮「新消息」 | `updateScrollPosition` / `userScrolledAway` / `hasNewMessage` |
| 切 tab / 恢复历史的精确视口位置 | `aiScrollAnchor`（item id + offset）+ `scrollToIndex` |
| 历史冷加载视觉抖动 | `isHistoryScrollPending`（opacity:0 → scrollHeight 稳定后淡入）；期间 + 淡入后短窗口 `suppressFollowAnimUntil` 只硬钉、禁指数追底（不延长打开等待） |
| 侧栏历史空闲预热 | `useConversationWarmup`：idle 串行 `warmHistoryConversation`（同构打开但不 focus）；`deviceMemory<4` 不预热；堆占用过高停队列 |
| 容器宽度变化导致的 reflow | `installContainerWidthObserver`（跟底时主动 `scrollToBottom`） |

### 已删除（勿再引入）

- `applyFollowingResize` / `applyReadingResize` / `isGrowthBelowViewport`（阅读态 scrollTop 补偿表）
- `aiScrollCache` / `restoreCache`（virtua CacheSnapshot 结构不同且不保证跨版本）
- `getItemSizeDeps` / `DynamicScrollerItem`（virtua 自动重测，无需手动 size-dependencies）

### 跟底动画约束

1. **用 `scrollTop` 指数逼近追底，禁止 translateY FLIP，禁止 from/to+p 三次缓动重定向**——后者在流式长高时会放大瞬时速度，造成流畅中的微跳。
2. **`doScrollIfNeeded` 禁止先硬钉底**——会把 gap 吃成 0，动画消失。主动跳底（`scrollToBottom`）才硬切。
3. **tick 每帧读最新 `scrollHeight`**，已在跑则不必 retarget；收束时只对齐 `latestTarget`，不要再调 `scrollerRef.scrollToBottom()`（易与 DOM scrollTop 不一致而跳一下）。
4. **曲线：`scrollTop += remain * (1 - exp(-k·dt))`**，`k≈14`；落后较多时可略 boost。禁止弹簧过冲。
5. **用户上滚必须 `cancelFollowScrollAnimation`**。
6. **历史冷加载（`hideUntilSettled`）禁止跟底滑动**：只硬钉 + opacity 隐藏；淡入后再禁约 400ms，挡住晚到测高，不额外拉长等待。

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

### 对外暴露（defineExpose）

| 方法 | 说明 |
|---|---|
| `analyzeText` / `addQuotedTerminalSelection` | 终端选区送入 Composer |
| `scrollToAgentStep(stepId)` | 滚到对话流指定 step 并短暂高亮；岗壳（如 AssistantWorkbench）持 ref 转发，供产出物「跳到生成处」 |

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
