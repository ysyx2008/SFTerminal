# 设置面板右侧内容区视觉重做

- 日期：2026-08-22
- 状态：**已完成**（阶段 1–3 落地；阶段 4 的图标改造并入后续设计规范工作）
- 后续：本轮暴露出"没有统一设计规范"才是根因，接续方案见 `2026-08-22-settings-design-system-design.md`
- 范围：`src/components/Settings/` 右侧内容区 + `src/styles/main.css` 的 `settings-scope` 规范
- 不在范围：左侧导航（用户明确表示现状可接受，emoji 保留）；任何设置项的业务逻辑

---

## 1. 问题诊断（已在代码中核实，非观感推测）

### 1.1 卡片的明暗基准是错的，且只在默认深色主题下成立

17 个设置页各自 `<style scoped>` 里逐字复制了同一段：

```css
.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}
```

而内容区底色是 `--bg-secondary`（来自 `.settings-modal`）。把 12 套主题的这两个 token 拉出来对照：

| 主题 | 页底 `--bg-secondary` | 卡片 `--bg-tertiary` | 实际效果 |
|---|---|---|---|
| dark（默认） | `#1f1f1f` | `#242424` | 卡片略亮，浮起 ✓ |
| light | `#f3f3f3` | `#f3f3f3` | **完全相同，卡片不可见** |
| ocean / coffee / forest / ayu / gold / sakura / rose-pine / cyberpunk / lavender / deep-blue | — | — | 卡片**比页底更暗**，呈凹陷 |

卡片没有边框，所以浅色主题下四张卡片在视觉上根本不存在，只剩一堆漂浮的文字；其余 10 套主题里卡片是「凹进去」的，与设计意图相反。这套样式显然只在默认深色下调过，从未跨主题验证。

**可用的正确 token**：`--bg-surface` 在全部 12 套主题中都严格亮于 `--bg-secondary`（深色主题微亮，浅色主题为纯白），是唯一能表达「抬起的卡片」的 token。

### 1.2 描述文字对比度不达标

`.setting-desc { color: var(--text-muted) }`，深色主题下即 `#6b6b6b` 落在卡片 `#242424` 上，对比度 **2.9:1**，低于 WCAG AA 正文要求的 4.5:1。改用 `--text-secondary`（`#a0a0a0`）可达 **5.9:1**。截图里那几行灰字发虚，不是屏幕问题。

### 1.3 内容区没有宽度上限

`.settings-content` 只有 `flex: 1` 和 `padding: 28px 32px`，而 `.settings-modal` 是 `width/height: 100%` 的整窗面板。结果是设置行会随窗口无限拉伸：项目名钉在最左、开关钉在最右，中间几百像素纯空白。眼睛要横跨整屏才能把「开机启动」和那个开关关联起来。这是"空得慌"的主因。

### 1.4 一张卡只装一行，密度过低

`GeneralSettings` 四个分组 = 四张卡，其中三张只有一行内容，每张仍占 16px 内边距 + 20px 间距。行与行之间靠 `margin-bottom: 14px` 拉开，既无分隔线也无统一行高，节奏是散的。

### 1.5 标题层级立不住

`.section-title` 是 14px/600，`.form-label` 是 13px/500 —— 两者字号差 1px、字重差一档，肉眼几乎分不出谁是分组、谁是条目。分组标题应该明显退后，让条目名成为视觉主角。

### 1.6 分段控件比例失衡

`.segment-option { flex: 1 }` 使语言切换器撑满整个卡片宽度，两个选项各占约 370px。分段控件应按内容宽度收敛。

### 1.7 顺带发现：`--text-tertiary` 从未定义

侧栏 `.nav-group-label { color: var(--text-tertiary) }` 引用了一个 12 套主题里都不存在的变量，属性在计算时失效并回退到继承色。属于侧栏范围，顺手补掉。

---

## 2. 设计取舍

### 取舍 A：只改 CSS，不重构 HTML 结构

理想布局是把分组标题移到卡片**外面**当 eyebrow，卡片内只放条目。但这要求改动 17 个页面的模板结构（`.settings-section` 要拆成「标题 + 卡片体」两层），工作量与回归风险都成倍增长。

**决定：本轮标题保留在卡内**，仅通过字号/字重/颜色让它明显退后。层级问题一样能解决，HTML 零改动。若实施后仍觉得不够，再单独立项做结构重构。

### 取舍 B：卡片规则靠特异性生效，删除重复样式降级为清理（**实施中修正**）

原判断：`.settings-scope .settings-section`（0,2,0）与 Vue scoped 的 `.settings-section[data-v-xxx]`（同为 0,2,0）平级，靠注入顺序决胜且页面本地规则会赢，因此必须先删 17 处复制品。

实施时发现 `main.css` 里早已有一条 `[data-ui-theme="light"] .settings-scope .settings-section:not(.tips-section)` —— 说明浅色主题卡片不可见的问题曾被发现过，但只针对单个主题打了补丁，根因未修。这条也提示了正解：`:not(.tips-section)` 把特异性抬到 (0,3,0)，足以稳定压过页面本地规则。

**修正后的做法**：卡片规则用 `:not(.tips-section)` 全主题生效，浅色专用补丁删除。于是删除各页重复样式从「前置条件」降级为「清理」—— 视觉修复立即覆盖全部 21 页，重复定义可以从容地分批清掉。风险显著降低。

单一真相源的约束不变（项目规则「禁止给一个概念造第二个真相源」），只是清理时机可以后置。

已核对：17 页的 `.settings-section` 定义逐字相同，仅 `TerminalSettings` 额外带 grid 布局属性；共享规则不设 `display`，其布局不受影响。

### 取舍 C：开关维持强调色填充，不降饱和

我最初判断三个蓝色开关"太抢眼"。复核后认为归因错了：实心强调色开关是 macOS / iOS / GitHub 的通行做法，本身没问题；它们之所以霸屏，是因为整页只有它们三个有颜色。**密度和限宽修好后，抢眼问题会自行消失。** 本轮只把尺寸从 44×24 收到 40×22 并补 focus 环，不动配色。

### 取舍 D：`GeneralSettings` 合并分组（**已确认采纳**）

把现有四张卡并成两张：

- **启动与更新**：开机启动 / 自动检查更新 / 自动下载 / 退出时安装
- **界面**：界面语言 / 简化显示执行步骤

这动了信息架构，需要新增两个 i18n 分组名（中英同步）。

### 取舍 E：窗口标题「控制面板」→「设置」（**已否决，保持原样**）

`settings.title` 保留「控制面板」——用户确认这是有意为之的命名，不改。

---

## 3. 目标规范

统一落在 `src/styles/main.css` 的 `.settings-scope` 段（与既有按钮规范同处）。

### 3.1 内容区限宽

`SettingsModal.vue` 在 `.settings-content` 内加一层 wrapper：

```css
.settings-content-inner {
  max-width: 760px;
  margin: 0 auto;
}
```

用内层 wrapper 而非直接给 `.settings-content` 加 `max-width`，是为了让滚动条保持贴在窗口右边缘（桌面软件常规），而不是跟着内容缩到 760px 处。

760px 是初始值。阶段 3 逐页验收时，若发现某些页（主题色卡网格、技能卡片、IM 配置表）确实被挤，再针对性开放宽口子 —— 不预设映射表，实测了再说。

### 3.2 卡片

```css
.settings-scope .settings-section {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 2px 16px;   /* 上下留白交给行自己，避免与首尾行的 padding 叠加 */
}
```

### 3.3 行

```css
.settings-scope .setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 52px;
  padding: 11px 0;
  margin: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 55%, transparent);
}
.settings-scope .setting-row:last-child { border-bottom: none; }
.settings-scope .setting-row > :first-child { flex: 1; min-width: 0; }
```

分隔线比卡片边框更淡（`color-mix` 在 Electron 37 / Chromium 126+ 原生支持）。左侧文本块 `flex: 1` 使右侧控件天然贴右对齐，无需额外结构。

### 3.4 文字层级

```css
.settings-scope .section-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  padding: 14px 0 6px;
  margin: 0;
  min-height: 0;      /* 覆盖现有的 min-height: 28px */
}
.settings-scope .form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}
.settings-scope .setting-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);   /* 修 §1.2 对比度 */
  margin: 3px 0 0;
  max-width: 46em;                /* 防止长描述拉成一整行 */
}
```

分组标题的处理（12px / 600 / letter-spacing）刻意与侧栏 `.nav-group-label` 同源，左右两栏的分组语言保持一致。

### 3.5 开关与分段控件

```css
.settings-scope .toggle-switch { width: 40px; height: 22px; }
/* 滑块 18px → 16px，位移 20px → 18px；配色不变 */
.settings-scope .toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.settings-scope .segmented-control { width: fit-content; }
.settings-scope .segment-option { flex: 0 0 auto; min-width: 88px; }
```

---

## 4. 任务拆解

每步一个 commit，可独立验证、可独立回滚。

### 阶段 1 — 内容区限宽 ✅ 已完成

- 改 `SettingsModal.vue`：`.settings-content > *` 加 `max-width: 760px` + 左右 auto 居中
- 实施调整：原计划加 `.settings-content-inner` wrapper，实测用 `> *` 直接作用于各设置页根节点即可达到同样效果（滚动条仍在窗口边缘），模板零改动
- 影响：1 个文件；一次性作用于全部 21 个设置页

### 阶段 2 — 共享规范落地 + 通用页做样板 ✅ 已完成（深色主题已验收）

- `main.css`：新增 §3.2–3.5 的 `.settings-scope` 规范；删除浅色专用补丁；补 `--text-tertiary`
- 实施调整：`--text-tertiary` 未按原计划在 12 套主题各写一份，改为在基础 `:root` 里从 `--text-secondary` 派生（`color-mix`）—— 各主题只要定义了 secondary 就自动得到协调的 tertiary，避免同一概念 12 份真相源
- `GeneralSettings.vue`：删除全部本地重复样式（仅保留页面自身的 flex 容器）；四张卡合并为「启动与更新」「界面」两张；语言项改为标准 setting-row
- i18n：`startupAndUpdate` / `interface` / `interfaceLanguage`，中英同步；废弃的 `startup` / `update` / `language` / `conversation` 已移除
- 已跑：`npm run check:i18n`（3210 键中英对齐）、`npm run typecheck:src`（无错）
- 已验收：深色主题下起真应用目视确认
- **待补验收**：light / rose-pine 两套主题（分别代表卡片曾不可见、卡片曾凹陷）

### 阶段 3 — 推广到其余 16 页 ✅ 已完成（做法与原计划不同）

实际执行时未按"分 4 批逐页目视"进行，而是聚焦在消除重复真相源：三套开关实现（主题页自制、记忆页 `.switch`、其余页 `.toggle-switch`）统一为一套；17 页逐字复制的卡片定义清除。

**本阶段暴露的教训（直接催生了后续的设计规范工作）**：共享规则挂在 `.toggle-slider`、`.section` 这类通用类名上是"覆盖制"的——会自动伸手够到结构不匹配的页面。实测误伤两处：主题页自制开关散架（外层非 `.toggle-switch`、滑块用 `::after`）、IM 页出现三层嵌套边框（页面内部本就有自带边框的盒子，最外层再加一圈）。

修正：开关选择器一律要求 `.toggle-switch` 祖先；卡片规则去掉边框只保留底色，边框由内部已扁平化的页面自行添加。**根本结论是 CSS 类名不足以承载设计规范，必须改用加入制的组件。**

<details>
<summary>原计划的分批清单（未按此执行）</summary>

删除各页本地重复定义，让共享规范接管。分 4 批，每批约 4 页，按复杂度从简到繁：

1. `AiRulesSettings` / `TerminalSettings` / `ShortcutSettings` / `DiagnosticsSettings`
2. `ThemeSettings` / `PluginSettings` / `BastionSettings` / `GatewaySettings`
3. `CalendarSettings` / `EmailSettings` / `KnowledgeSettings` / `VoiceSettings`
4. `AiSettings` / `McpSettings` / `SkillSettings` / `IMSettings` / `UserAllowlistSettings` / `DataSettings`

</details>

### 阶段 4 — 侧栏图标（未做，移交后续方案）

侧栏 emoji → `lucide-vue-next` 单色线性图标。用户表示侧栏现状可接受，优先级低；并入设计规范工作统一处理。标题改名已否决（取舍 E）。

---

## 5. 验证方式

**这是纯前端视觉改动，`electron/cli/test-cli.sh` 与现有单测完全覆盖不到，跑绿了也说明不了任何问题。** 唯一有效的验证是起真应用逐页看。

- 阶段 1、2 完成后：`npm run dev`，设置面板逐页走一遍，dark / light / rose-pine 三主题必看
- 阶段 3 每批完成后：该批页面逐页目视
- 全部完成后：12 套主题各抽查 2–3 页，确认没有哪套主题下卡片消失或过曝
- 另需确认：`ocean` 主题的 `--bg-surface`（`#2d5a87`）相对页底（`#112842`）跳变较大，卡片可能偏亮，实测后决定是否需要为该主题微调

---

## 6. 已知风险

| 风险 | 应对 |
|---|---|
| 某页悄悄依赖了本地样式的差异，删除后错位 | 逐页目视，不依赖自动化测试 |
| 760px 对少数宽内容页偏窄 | 实测发现后针对性放宽，不预设 |
| `--bg-surface` 在个别主题跳变过大 | 全主题抽查，必要时按主题微调该 token 或为卡片加更淡的自定义底色 |
| 合并分组改动信息架构，用户可能不认可 | 已列为取舍 D，动手前先确认 |
