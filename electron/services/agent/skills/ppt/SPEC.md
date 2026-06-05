# PPT 技能 (ppt skill)

> Last verified: 2026-06-05

## 职责

为 Agent 提供 **幻灯片 HTML → `.pptx`** 的一-shot 导出，与 `word_from_markdown` / `excel_from_markdown` 同构。

- **中间表示**：约束版 HTML（每页一个 `.slide`，见 `contracts/slide-html.md`）
- **导出引擎**：PptxGenJS（本地 Node，无云端 API）
- **预览**：同一份 HTML 通过 `CanvasData` 推送到独立助手右侧 Canvas（`renderer: 'html'` → `SlidesRenderer`）

设计规范与 QA 思路借鉴 [Anthropic pptx skill](https://github.com/anthropics/skills/tree/main/skills/pptx)（配色/排版/反模式、导出后抽检）；**不**采用其「AI 手写 PptxGenJS」或 Python OOXML 编辑路径。

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.ts` | 注册 skill、`content`（设计指引摘要 + 契约链接） |
| `tools.ts` | `ppt_from_html` 工具 schema |
| `executor.ts` | 工具分发、写盘、Canvas 推送 |
| `html-to-pptx.ts` | HTML 解析 → PptxGenJS 映射 |
| `layouts.ts` | `data-layout` → 坐标/元素模板 |
| `themes.ts` | 预设主题（配色/字体，对齐 Anthropic 调色表） |
| `contracts/slide-html.md` | **HTML 契约单一数据源**（Agent + 转换器共用） |
| `__tests__/html-to-pptx.test.ts` | 各 layout fixture 回归 |

## 公开 API（工具）

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `ppt_from_html` | 从 slide HTML 生成 `.pptx` 并打开 Canvas 预览 | `path`（.pptx）、`html` \| `html_path` 二选一、`theme`、`layout`（默认 16:9） |

**v2（本 SPEC 范围外）**：`ppt_read`（文本提取）、`ppt_from_template`（OOXML 模板编辑）。

## 数据流

```
Agent 生成 slide-safe HTML
    ├─► [可选] 流式阶段：Canvas update（html，仅 assistant 模式）
    ├─► 写 deck.html（与 .pptx 同目录或 agent-workspace，便于重导）
    ├─► html-to-pptx → .pptx
    └─► tool_result + canvasData { renderer: 'html', content, filePath: deck.html }
```

导出失败时仍尽量保留 `deck.html` 与 Canvas 预览，便于用户改 HTML 后重试。

## Canvas 预览

- 类型：`shared/types/canvas.ts` 已声明 `renderer: 'html'`，前端需新增 `SlidesRenderer.vue` 并在 `CanvasPanel.vue` 挂载。
- **内容**：完整 HTML 文档或片段（executor 包一层预览壳：16:9 缩放、纵向滚动、页间分隔）。
- **filePath**：保存的 `deck.html` 绝对路径 → 标题栏「打开 / 在文件夹中显示」与 Markdown Canvas 一致。
- **关闭**：`ppt_from_html` 成功不自动关 Canvas（与 Word 一致）；用户关 tab 时 `canvasStore.cleanup`。
- **WYSIWYG 边界**：预览按 **Web/CSS** 渲染；PPTX 由 layout 引擎映射，复杂 style v1 可能略有偏差——契约文档需写明「以导出结果为准，预览用于结构与文案」。

## html-to-pptx 转换（v1）

- 解析：`node-html-parser`（纯 JS，**不用 jsdom**，避免 Electron 启动时拉取 `canvas` 原生模块）
- 分页：根下每个 `section.slide`（或 `div.slide`）= 一页
- 版式：读 `data-layout`，在 `layouts.ts` 中查表调用 PptxGenJS（**不**解析 Flex/Grid）
- 主题：读 `data-theme` 或 `theme` 参数，合并 `themes.ts`
- 元素：`h1–h3`、`p`、`ul/ol`、`img`、`table`、`div.col-left/right`、`div.stat`
- 图片：仅本地绝对路径 / `file://` / base64；chart 产物用 `<img src="绝对路径">`
- PptxGenJS 坑：见 Anthropic `pptxgenjs.md`（无 `#` 色值、bullet 不用 `•`、options 对象勿复用等）——在 `html-to-pptx.ts` 内硬编码

**v1 layouts**：`title` | `content` | `two-column` | `stat-callout` | `image-bleed` | `closing`

## 依赖

| 依赖 | 用途 |
|------|------|
| `pptxgenjs` | 写 `.pptx`（**待加入** `package.json`） |
| `node-html-parser` | 解析 Slide HTML（无 canvas 原生依赖） |
| `fs` / `path` | 写 deck.html、pptx |
| chart skill（可选） | 幻灯片内图表 PNG |
| `shared/types` `CanvasData` | 预览推送 |

## 关键约束

- **supportedModes**：`local` | `assistant`（与 `dispatch_agents` 一致，无 SSH 远程 ppt）
- 单页画布默认 **1600×900px**（16:9）；转换按 10"×5.625" 映射
- 单 job 建议 ≤ 50 页（软限制，防 token/超时）
- HTML 契约变更须同步 `contracts/slide-html.md` 与 skill `content`
- 前后端类型：若新增 `PptSlideLayout` 等放 `shared/types/`，禁止在 Vue/electron 重复定义

## 前端配套（已实现）

1. `SlidesRenderer.vue` — `renderer: 'html'`，纵向滚动预览 deck HTML
2. `CanvasPanel.vue` — 挂载 SlidesRenderer + Presentation 图标
3. i18n：`terminal.canvas.slidesPreview`、`ai.agentWelcome.scenarios.deckFromReport`
4. `assistantExamples`：`deckFromReport` 场景卡片

## 测试

- 单元：`html-to-pptx.test.ts` — 每 layout 一个最小 HTML fixture，断言 pptx 可写、页数正确
- 手工：独立助手模式生成 5 页 deck，Canvas 预览 + 用 PowerPoint/Keynote 打开 pptx

## 参考

- HTML 契约：`contracts/slide-html.md`
- Anthropic 设计/QA：`skills/pptx/SKILL.md`（skill content 摘录，非代码依赖）
- html2pptx 契约对照：`.slide` + 显式尺寸（我们 v1 用 `data-layout` 收窄 CSS 范围）
