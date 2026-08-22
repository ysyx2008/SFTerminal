# 首页欢迎页视觉与信息架构重做

- 日期：2026-08-22
- 状态：**未完成**（步骤 1 视觉降噪已完成；步骤 2–4 待做）
- 范围：`src/components/WelcomePage.vue`、`src/components/WelcomeChatComposer.vue` 的容器样式、i18n `welcome.*`
- 不在范围：侧栏 `AppSidebar.vue`（本轮只读它的既有信号，不改它）；`RecentConversationsPanel`
- 范围已扩：`AiComposer` 的主操作键 —— 原定不碰，实施中发现是实现漏洞（变体色相互撞、假渐变）而非审美偏好，就地修了，见 §4 末

---

## 1. 问题诊断（已在代码中核实，非观感推测）

### 1.1 功能入口在同一屏出现两次，且右侧视觉权重压倒左侧

侧栏 `AppSidebar.vue` 的 `place-nav` 已有三个固定入口（新对话 / 联络 / 终端），每个带 `lucide` 16px 单色线稿图标 + `stroke-width: 1.75`。

而 `WelcomePage.vue` 的 `.quick-start` 又给出四张 150px 高的卡片：AI 助手（= 新对话）、本地终端 / SSH 连接（= 终端）、关切。前三张与侧栏语义重叠，第四张的入口在秘书菜单里也已存在（`pick('open-watch')`，带 `watchAnomalyCount` badge）。

结论：卡片区没有承担独有职责，是 2026-08-14 侧栏改成固定入口后遗留的重复层。

### 1.2 视觉重心落在装饰上，不在主行动上

整屏唯一的高饱和色是四个 46px 渐变填充图标块：

```css
.card-icon.assistant { background: linear-gradient(135deg, var(--brand-assistant), var(--brand-assistant-end)); }
/* local / ssh / patrol 同构；watch 硬编码 #f59e0b → #d97706 */
```

而真正的主行动 —— `WelcomeChatComposer` 那个输入框 —— 在桌面软件的视觉惯例里，2px 亮强调色描边通常表示「聚焦中」或「校验未通过」，不是「静止等你输入」。

与设置页 plan 取舍 C 同一诊断：色块抢眼不是配色本身有错，是**整屏只有它们有颜色**。

### 1.3 装饰层叠：单次 hover 触发六重反馈

`.action-card:hover` 同时改动 border-color、border-width（1px→2px，会引起亚像素重排）、`translateY(-4px) scale(1.03)`、`background` 混色、28px 品牌色外发光、`::before` 柔光环 opacity、`::after` 径向光晕，`.card-icon` 另有 `scale(1.05) translateY(-2px)` + `saturate(1.2) brightness(1.08)`。

`.session-item::before` 另有一道 `left: -100% → 100%` 的横向扫光。

`.sailfish-logo` 常态挂着 `animation: float 3s ease-in-out infinite` —— 一个永不停止的运动元素，加 `drop-shadow(0 4px 16px rgba(accent-decorative, 0.4))` 光晕。

### 1.4 排版沿用英文设计，且与设置页刚落地的规范不是一套

| 位置 | 现状 | 设置页已定规范 |
|---|---|---|
| 分组标题 | `13px / 700 / text-transform: uppercase / letter-spacing: 1px / text-secondary / opacity: 0.8` | `12px / 600 / letter-spacing: 0.05em / text-secondary` |
| 描述文字 | `11px / --text-muted` | `12px / --text-secondary`（`--text-muted` 已判为对比度 2.9:1 不达标） |
| 内容列宽 | `max-width: 780px` | `760px` |

`text-transform: uppercase` 对中文是空操作，只剩 1px 字距，`opacity: 0.8` 叠在 `--text-secondary` 上进一步压低对比度。

### 1.5 主标题是营销页规格，且渐变未跨主题验证

```css
.welcome-title {
  font-size: 26px; font-weight: 800; letter-spacing: -0.5px;
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-primary) 100%);
  -webkit-text-fill-color: transparent;
}
```

浅色主题另打了一条补丁（起点从 0% 挪到 20%）—— 与设置页 §1.1 同型：**只在两套主题上调过，剩下 10 套没验证过**。渐变文字失效时会整段透明（不可读），比普通降级严重。

### 1.6 卡片 150px 高，内容只占约一半

`padding: 16px 12px` + 46px 图标 + 14px 标题 + 11px 描述 ≈ 95px 内容，硬撑到 `height: 150px`。这是空，不是留白。

### 1.7 内容全是静态罗列，没有反映「我的状态」

除三条最近 SSH 连接外全为常量。用户第 100 次打开与第一次所见相同。

而「需要注意的事」这套信号在代码里**已经全部存在**，只是没有一处把它们摊开讲：

| 信号 | 现有真相源 | 现在只用于 |
|---|---|---|
| 等你确认 / 后台刚跑完 | `terminalStore.getTabAgentUiMeta(tabId)`（`pendingConfirm` / `agentCompletedUnseen` / 聚合 `needsAttention`） | 侧栏三个入口的小圆点、TabBar `needs-attention` |
| 关切异常（failed / timeout） | `useWatchAnomalyCount()` | 首页卡片角标、侧栏秘书头像点 |
| 逾期待办 | `useTodoOverdueCount()` | TabBar、秘书菜单 badge |
| 会话失败 | 历史索引 `AgentHistorySummary.status: 'completed' \| 'failed' \| 'aborted'` | 未使用 |

侧栏的圆点只说「这里有事」，不说「什么事」。首页大面板正是摊开讲的地方 —— 同一真相源的不同粒度，不是第二个真相源。

### 1.8 关键约束：Steam 版没有输入框，卡片是它唯一的入口

```js
const canShowAssistant = !isSteamBuild && isWorkbenchAvailable('assistant')
```

`WelcomeChatComposer`、`.examples-hint` 都挂 `v-if="canShowAssistant"`；`canShowWatch` 同样对 Steam 为 false。

所以 Steam 版首页 = logo + 标题 + 两张卡（本地终端 / SSH）+ 最近连接 + tips。**卡片区一删，Steam 版首页将不含任何可点入口。** 这条不核实就动手会直接做出一个不可用的 Steam 首页。

---

## 2. 设计取舍

### 取舍 A：删掉「快速开始」，但按构建分叉（**已确认**）

- **完整版**：`.quick-start` 整块移除。入口职责交回侧栏（新对话 / 联络 / 终端）与秘书菜单（关切 / 待办）。
- **Steam 版**：保留卡片区（见 §1.8），继续用卡片形态，只接受本轮视觉降噪（去渐变、收高度、减 hover）。

用 `v-if="isSteamBuild"` 表达，而非维护两份模板。Steam 版优先级低，本轮以「能用」为准，不另设形态。

### 取舍 B：下半屏放「需要你注意的」，不放全量历史（**已确认**）

条目一律从 §1.7 的既有真相源读，**不新建任何判定逻辑**（项目规则：禁止给一个概念造第二个真相源）。

| 条目 | 数据来源 | 点击行为 |
|---|---|---|
| 等你确认 | 遍历 `terminalStore.tabs`，`getTabAgentUiMeta(id).pendingConfirm` | 聚焦该会话 |
| 后台刚跑完 | 同上取 `agentCompletedUnseen` | 聚焦该会话 |
| 关切异常 | `useWatchAnomalyCount()` | 打开关切总览 |
| 逾期待办 | `useTodoOverdueCount()` | 打开待办面 |
| 最近失败的会话 | 历史索引 `status === 'failed'`，24h 内 | 打开该会话 |

前两条需要指名「是哪条会话」，因此按 tab 遍历而非用聚合布尔 `hasTasksAreaAttention` —— 同一 getter，只是不聚合。

**`aborted` 明确不算异常**：用户随手停掉 Agent 是正常操作，计入会让首页长期挂着噪音。只取 `failed`，且加 24h 窗，否则历史上所有失败会话会永久堆积。

### 取舍 C：空态就是不渲染（**已确认**）

「没有需要注意的事」是常态。此时下半屏整块不渲染，首页 = logo + 一行招呼 + 输入框，参照 Claude / ChatGPT 的起手页。

- 现有 `padding: clamp(40px, calc(50vh - 300px), 150px)` 本就是为「logo 与输入框位置不随内容高度浮动」设计的，块的出现/消失不会推动上半部分。
- 不放「一切正常」之类的占位 —— 没有坏消息就是好消息，不值得占一行。

### 取舍 D：「最近连接」撤出首页（**已确认**）

完整版撤掉：最近 SSH 连接不属于「需要你注意的」，且侧栏「终端」页已承载会话列表（`focusTerminalPlace`）。

Steam 版保留：它没有侧栏助手区，最近连接仍是有效入口。与取舍 A 同一条分叉线。

### 取舍 E：图标改线稿，但保留品牌色作前景（**实施中修正**）

原判断：统一单色线稿，取色 `--text-secondary`，色彩只在 hover 时透出。

步骤 1 实施后目视结论：**过度了 —— "高级了一点，但素得很，整体单调"。** 归因错在把「饱和渐变色块」的问题当成了「有颜色」的问题。真正的问题是**色彩的载体**：同一个色相铺在 46px 实心块上是噪音，落在 1.75px 的线条上是点缀。

修正后的做法：图标改线稿（这条不变），但**取色用各自品牌色**，配一层极淡的同色底板（约 12% 透明）让图标有位置感。四个彩色锚点回来了，识别性（紫=助手、绿=本地、蓝=SSH、橙=关切）也回来了，重量却只有原来的零头。

`.examples-hint-btn` 里的 `💡` emoji 换 `Lightbulb`（与设置页 plan 阶段 4「侧栏 emoji → lucide」同向）。

### 取舍 F：动效减幅，不清零（**实施中修正**）

原判断：删除常态 `float ... infinite` —— 「永不停止的运动元素长期占用注意力」。

目视结论：**这条只在幅度大时成立。** 原动画 3s 周期 / 10px 幅度确实过于活跃，但直接删掉之后 logo 像贴在背景上的贴纸，产品的人格没了 —— 旗鱼在游是这个应用的性格，不是装饰。

修正后的做法：**减幅而非删除** —— 周期拉长到 6s、幅度收到 5px，从「蹦」变成「呼吸」；常态光晕保留但减弱。有生命感，不抢注意力。

保留不变：Logo 连点 20 次的 `MatrixRain` 彩蛋；诞生引导的挥手 + `meetPulse`（有明确目的 —— 引导注意到「初次见面」按钮）。

---

## 3. 目标规范

### 3.1 版式

```css
.welcome-content { max-width: 760px; }   /* 对齐设置页 */

.welcome-title {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--text-primary);
  /* 渐变与 -webkit-text-fill-color 全部移除，浅色主题补丁一并删除 */
}

.welcome-subtitle { font-size: 13px; color: var(--text-secondary); }  /* 去掉 opacity: 0.85 */

.section-title {
  font-size: 12px; font-weight: 600; letter-spacing: 0.05em;
  color: var(--text-secondary);
  /* 移除 text-transform: uppercase 与 opacity */
}
```

### 3.2 输入框容器

`.welcome-chat-composer` 的边框改为常态 `1px var(--border-color)`，仅 `:focus-within` 上强调色；圆角向设置页卡片对齐（10–12px）。

具体值需起真应用比对 —— 边框粗细与颜色是 `AiComposer` 还是 `WelcomeChatComposer` 给的，实施时先核实归属，改在容器层，不动 `AiComposer` 内部（它被多处复用）。

### 3.3 注意力条目

单行列表形态，非卡片：

```css
.attention-item {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px; padding: 10px 12px;
  background: var(--bg-surface);            /* 与设置页卡片同 token */
  border: 1px solid var(--border-color);
  border-radius: 10px;
}
.attention-item:hover { border-color: var(--accent-decorative-primary); }
```

严重度只用图标颜色区分（异常 → `--error` 系，待确认 → `--warning` 系，完成 → `--text-secondary`），不用填充底色。

### 3.4 保留的卡片（Steam）视觉降噪

- `height: 150px` → `min-height: 104px`，让内容定高度
- `background: var(--bg-secondary)` → `var(--bg-surface)`（对齐设置页；需 12 主题实测，见 §5）
- hover 收敛为：`translateY(-2px)` + `border-color` + 极轻底色变化
- 删除 `::before` 柔光环、`::after` 径向光晕、`scale`、外发光、`border-width` 变化、`.card-icon` 的 `filter` 提色
- `.card-desc` → `12px / --text-secondary`

---

## 4. 任务拆解

每步一个 commit，可独立验证、可独立回滚。前三步纯减法，风险低；第四步是唯一的加法。

- [x] **步骤 1 — 视觉降噪（纯 CSS + 两处 emoji 换图标）** ✅ 已完成（dark 主题已验收）
      标题去渐变降级为 22px/600 纯色（浅色专用补丁一并删除）；section-title 与 card-desc 对齐设置页规范；内容列 780→760；卡片 hover 六重收敛为三重；删 `.session-item` 扫光与 `.tips` 渐变底+闪光；`💡` → `Lightbulb`。
      实施调整（与原设计的偏离，取舍 E / F 已记录归因）：
      - 图标改线稿但**保留品牌色前景 + 12% 同色底板 + 24% 发丝边**，不是原计划的中性灰 —— 全中性化后目视「素得很」
      - logo 浮动**减幅保留**（3s/10px 原节奏）而非删除；曾试过 6s/5px「呼吸」，被判定节奏不对
      - 卡片补上 `--shadow-sm` 静态高度阴影、hover 抬到 `--shadow-lg`：立体感原本由图标色块下的彩色投影承担，换线稿后必须由卡片本体接手
      - 顺手修反向手感：`.session-item` hover 原本换 `--bg-tertiary`（多数主题下比卡片底色更暗，读起来像被按下去），改为提亮 + 加阴影；底色一并对齐到卡片用的 `--bg-surface`
      - 卡顿修复：logo 的浮动/挥手动画移到一层无滤镜的包裹元素上，`drop-shadow` 留在图片上保持静态 —— 带滤镜的元素自己做 transform 动画会每帧重算滤镜、走不了合成器
      *待补验收：light / rose-pine 两主题；首次运行的挥手引导（挥手轴心已随动画换了宿主元素）。*

- [ ] **步骤 2 — 输入框成为唯一焦点**
      核实描边归属后改容器层：常态低对比边框，`:focus-within` 才上强调色。
      *验收：不聚焦时输入框不像「出错」；点进去有明确聚焦反馈。*

- [ ] **步骤 3 — 移除重复入口**
      `.quick-start` 改 `v-if="isSteamBuild"`；按取舍 D 决定「最近连接」去留（完整版撤 / Steam 保留）；清理只剩 Steam 用得到的 i18n 键与 emit（`open-assistant` / `open-local` / `open-session-manager` / `open-watches` 的调用点在 `App.vue`，撤前需确认无其他调用方）。
      *验收：完整版与 Steam 版分别起一次，确认两边都还有可用入口。*

- [ ] **步骤 4 — 「需要你注意的」区块**
      新增 composable 聚合 §2 取舍 B 的五类信号（只读既有来源，不新建判定）；条目组件 + 空态整块不渲染；i18n 中英同步。
      *验收：人为造出每一类条目各看一次 —— 停一个待确认的危险命令、让一个关切失败、造一条逾期待办、跑一个失败会话。这类东西单测测不出来，只能造出来看。*

---

### 顺带修掉的：Composer 主操作键（**超出原范围，已完成**）

范围外发现，但由「首页要精致」直接引出，就地修了。作用于 `AiComposer`，**所有 composer 共享**（欢迎页 / 助手面板 / 终端 AI 面板）—— 刻意不为首页另造一套样式，那会给同一个按钮造第二个真相源。

两个实现漏洞，不是审美问题：
- **绿按钮底下压着蓝光**：变体类只覆盖 `background`，没覆盖基类里硬编码的蓝色投影，色相互撞
- **渐变是假的**：变体的三个渐变节点填同一个色值，实际是块扁平纯色

修法：主操作键的外观收成一处定义，各状态只改一个色调变量（发送绿 / 补充橙 / 停止红），底色渐变与按下态从它派生。同时收尺寸 34→32px、圆角 10→9px、箭头 18→17px 但描边加粗到 2.25，补 `:active` 内投影与 `:focus-visible` 焦点环。

「停止」键一并纳入：它是发送键的同槽兄弟（发送中会换成它），有一模一样的假渐变，不一起改切状态时会看出断层。

投影改了两轮才走对路：先是品牌色外发光（32px 下把边缘晕开、看着发糊），退成紧贴的中性投影 + 顶部内高光，目视仍到不了「精致」。第三轮换掉的是判断本身——**32px 上没有立体感可做**：渐变跨不出层次、黑投影在深色底上看不见，打光只让边缘发灰。于是整块做成纯平实色，这个尺寸的存在感只能靠色块与底色的对比。

同轮带出的三件事：
- **一行按钮统一进 32px 方格**：麦克风/附件原为 34px、主操作键 32px —— 最重要的那个反而最小，一行读起来是拼的
- **按内容配重而非按尺寸对齐**：箭头 16px/描边 2（小尺寸加粗只会糊），停止键的实心方块收到 12px —— 实心块比同尺寸线稿重得多，不收就压场
- **禁用态退成中性灰**：半透明品牌绿压在深色底上会变成发闷的橄榄色，读起来像「坏了」而不是「还不能发」；顺带让空输入框安静下来

手感统一为「悬停只换色、按下才缩」—— 原先主操作键上跳 1px、邻近图标悬停放大 8%，一行东西此起彼伏。

**遗留（用户目视发现，待修）**：按钮圆角与外框圆角不成同心（外框 16px、按钮 9px、间距不等）；两行模式外框右内边距 10px 而下内边距 6px，主操作键到右边和到下边的距离对不齐 —— 纯平实色让边界变利落之后，这类几何误差反而更显眼了。

## 5. 验证方式

**纯前端视觉与信息架构改动，`electron/cli/test-cli.sh` 与现有单测完全覆盖不到，跑绿了说明不了任何问题。** 与设置页 plan §5 同理。

- 每步完成后 `npm run dev` 起真应用目视
- 主题：dark / light / rose-pine 必看（分别代表默认、卡片曾不可见、卡片曾凹陷）；全部完成后 12 套主题抽查
- 构建分叉：完整版与 Steam 版（`__STEAM_BUILD__`）各走一遍，确认都有可用入口
- 首次运行路径：清掉 `agentOnboardingShown` / `agentOnboardingCompleted`，确认「初次见面」引导的挥手 + 文案交叉淡入 + 按钮脉动未被降噪改动破坏
- `npm run check:i18n`（中英键对齐）、`npm run typecheck:src`
- 步骤 4 完成后：五类注意力条目逐类人为造出来看

---

## 6. 已知风险

| 风险 | 应对 |
|---|---|
| 常态首页只剩输入框，用户觉得太空 | 取舍 C / D 动手前先拍板；步骤按纯减法在前排序，步骤 3 之后即可先看效果再决定要不要步骤 4 |
| Steam 版被误删入口 | §1.8 已核实；步骤 3 验收强制两个构建各起一次 |
| `aborted` 会话涌进注意力区变噪音 | 取舍 B 已排除 `aborted`，只取 `failed` + 24h 窗；实测数据量后再定是否还要收紧 |
| 注意力区另造一套判定逻辑，与侧栏圆点讲不一致的话 | 取舍 B 强制复用 `getTabAgentUiMeta` / 两个既有 composable / 索引 status |
| `--bg-surface` 在个别主题跳变过大 | 与设置页同一风险项，沿用其结论；12 主题抽查 |
| 改动 `WelcomeChatComposer` 描边时误伤复用的 `AiComposer` | 只改容器层；改前先核实描边归属 |
| 撤掉 emit 时漏掉其他调用方 | 步骤 3 撤前查 `App.vue` 全部调用点 |

---

## 7. 完成时要做的事

- 讨论确认的稳定取舍升华进对应 SPEC 的设计目标（转译为用户语言，去掉实现名）—— 首页职责边界（谁负责入口、首页只讲「需要你注意的」）属于设计决策，需要落 SPEC
- 文件名改 `done-2026-08-22-welcome-page-redesign-design.md`，文首改「已完成」，任务拆解勾掉
