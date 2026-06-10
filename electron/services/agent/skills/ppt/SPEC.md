# PPT 技能 (ppt skill)

> Last verified: 2026-06-10

## 职责

为 Agent 提供生成「原生可编辑」`.pptx` 演示文稿的能力，单一路线 **html2pptx**（对标 [Anthropic pptx skill](https://github.com/anthropics/skills/tree/main/skills/pptx) 现行做法）：

1. AI 写 **HTML**（每页一段 body 内联 HTML，绝对定位排版）
2. 用**真实 Chromium** 渲染该页，遍历 DOM 读 `getBoundingClientRect` + `getComputedStyle`
3. 把每个元素映射成**原生 PptxGenJS 元素**（文本 / 列表 / 卡片 shape / 图片 / 边框线）——文字可编辑，布局由浏览器排版，从根上避免 AI 手算坐标导致的重叠/错乱
4. 渲染期**内置校验即 QA**：内容溢出、CSS 渐变、文本元素带背景/边框/阴影、div 裸文本、手敲项目符号——全部按页报错，引导 AI 改 HTML 重试
5. 同一份 HTML 通过 `CanvasData`（`renderer: 'html'` → `SlidesRenderer`）推送到助手 Canvas 预览（单个 sandbox iframe，每页一个等比缩放 `.stage`，所见即所得）

- **导出引擎**：PptxGenJS（本地 Node，无云端 API）

## 渲染后端

统一用 **`playwright-core` 启动系统浏览器**（headless，独立进程），与 `browser` 技能同款做法（`detectBrowser` 找 Chrome/Edge/Chromium）。渲染发生在独立进程，**绝不阻塞 Electron 主进程事件循环**。

> ⚠️ 早期版本曾在主进程开隐藏 `BrowserWindow` 渲染（想做到零依赖），实测会**冻住整个 app UI**（主进程被阻塞），已弃用。CLI 与真实 app 走同一条 playwright 路径。无系统浏览器时报 `NO_BROWSER`。

## 文件结构

| 文件 | 说明 |
|------|------|
| `index.ts` | 注册 skill、`content`（HTML 创作指南 + 规则 + 示例，**内联**避免运行时读外部文件） |
| `tools.ts` | `ppt_from_html` 工具 schema（`slides[]` / `css` / `size` / `path` / `title`） |
| `executor.ts` | 工具分发、写盘、覆盖确认、Canvas 推送、校验错误回传 |
| `html-render-pptx.ts` | **核心引擎**：提取脚本（字符串）+ 双后端渲染 + 纯映射器（`applyBackground`/`applyElements`）+ `renderHtmlToPptx` |
| `preview.ts` | Canvas 预览文档：单文档内每页一个等比缩放 `.stage`（无内层 iframe、无脚本），本地图片内联为 data: URI |
| `contracts/slide-html.md` | HTML 契约单一数据源（开发文档；AI 运行时看 `index.ts` content） |
| `__tests__/html-to-pptx.test.ts` | 纯映射器单测 + 浏览器可用时的真渲染集成测试 |

## 公开 API（工具）

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `ppt_from_html` | 写 HTML 幻灯片 → 原生可编辑 `.pptx` + Canvas 预览 | `path`（.pptx）、`slides`（每页 body 内联 HTML 数组，必填）、`css`（共享样式）、`size`（widescreen/standard）、`title` |

**输入模型**：`slides` 每项是一页的 body 内联 HTML（不写 `<html>/<head>/<body>`）；`css` 是所有页共享的 `<style>` 文本。系统用 `wrapSlideHtml` 包成完整文档、把 body 固定为画幅尺寸（widescreen 1280×720px = 13.333"×7.5"，standard 960×720px = 10"×7.5"，96 px/in）。

**逐页追加（防模型输出截断）**：`mode` = `replace`（默认，整本重建）| `append`（追加到同 path 已有 deck 末尾）。真相源是隐藏点文件 `.<deck>.deck.json`（`{title,size,css,slides[]}`，Finder 默认不显示，不污染用户目录）——append 读它合并新页、整本重渲、重写 pptx + deck.json。长 PPT 可分多次 append，每次只发一小批，避免单次输出超长被截断。

**渲染缓存 + 进度**：`renderSlides` 按 `sha1(layout+css+html)` 缓存每页 `SlideData`（上限 300，FIFO），append 整本重渲时旧页秒回、只渲新页。`RenderControls.onProgress({done,total})` 每页回调 → executor `updateStep` 显示「渲染中 i/N 页」；`isAborted()` 支持中途取消。

## 数据流

```
AI 写 css + slides[]（mode replace/append）
    ├─► append 读 .<deck>.deck.json 合并旧+新 slides
    ├─► buildPreviewDocument（仅内存，供 Canvas 内联预览，不落盘）
    ├─► renderSlides：每页 wrapSlideHtml → playwright 渲染 → 提取脚本 → SlideData
    │     （命中 sha1 缓存的页跳过渲染；onProgress 逐页回调更新进度 step）
    ├─► 聚合每页 errors；有错 → PptValidationError（逐页问题回传，AI 改后重试，不写 pptx）
    ├─► 无错 → PptxGenJS：每页 addSlide + applyBackground + applyElements → writeFile
    ├─► 成功后写 .<deck>.deck.json（隐藏真相源，供后续 append）
    └─► tool_result + canvasData { renderer:'html', content: 预览文档, filePath: pptx }
```

## 元素映射（提取脚本 → PptxGenJS）

| HTML | PPT 元素 | 说明 |
|---|---|---|
| body 背景色 | `slide.background` | CSS 渐变不支持（报错，用纯色或 `.bg` div） |
| `<p>/<h1>-<h6>` | 文本框 | 读 font/color/align/lineSpacing/位置；支持 `<b><i><u><span>` 行内格式；带 bg/border 时拆成形状+文字 |
| `<span>`（独立徽章） | 文本框（可选形状底） | 行内 span 由父级文本吸收；独立 span 提取为文字 |
| `<div>`（仅裸文本） | 文本框 | 无子元素时的裸文本 div（如 AI 用 div 做标题）按 `<p>` 提取 |
| `<ul>/<ol>` | 项目符号文本块 | `<li>` → bullet run |
| `<div>`（带 bg/border/radius/shadow） | 形状（rect/roundRect） + 可能的边框线 | 卡片/色块；子文本元素独立渲染在上层 |
| `<img>` | 图片 | 绝对路径 / `file://`；图表先 chart 技能出 PNG |
| `class="placeholder"` | 占位坐标 | 供后续图表插入（预留） |

## Canvas 预览

- `renderer: 'html'`（`shared/types/canvas.ts`），前端 `SlidesRenderer.vue`（iframe srcdoc）+ `CanvasPanel.vue` 挂载
- `content`：完整 HTML 文档（仅内联推送，不落盘）。**单文档单 iframe**：每页放进一个固定画幅的 `.stage`（`position:absolute`，幻灯片内的绝对定位以此为基准），纯 CSS 容器查询 `transform:scale(calc(100cqw / 画幅宽))` 适配容器宽 → 所见即所得
- **不用内层 iframe**：所有页本就共享同一份 css，无隔离需求。外层 SlidesRenderer iframe 是 `sandbox="allow-same-origin"`（无 allow-scripts），若在其中再创建无 allow-scripts 的 srcdoc 子帧，Chromium 会对每个子帧发出 benign 的 "Blocked script execution in about:srcdoc"。单文档零嵌套 iframe + 零脚本 → 控制台干净
- **本地图片内联**：sandbox iframe 无法加载 `/abs/path.png`/`file://` 本地路径（显示空白），`buildPreviewDocument` 在 Node 侧读盘把 `<img src>` 的本地图片转成 `data:` URI（单图上限 8MB，失败则原样保留）。导出 pptx 不受影响（pptxgenjs 直接读盘嵌入）
- `filePath`：导出的 `.pptx` 绝对路径 → 标题栏「打开 / 在文件夹中显示」直接定位成品
- WYSIWYG 边界：预览用真实浏览器渲染，与导出走同一 wrapper，偏差极小；最终以 PowerPoint 打开为准

## 依赖

| 依赖 | 用途 |
|------|------|
| `pptxgenjs` | 写 `.pptx` |
| `playwright-core` + `browser/detector` | 渲染后端（headless 系统浏览器，独立进程） |
| `fs` / `os` / `path` | 临时渲染 HTML、隐藏 deck.json、pptx |
| chart skill（可选） | 幻灯片内图表 PNG |
| `shared/types` `CanvasData` | 预览推送 |

## 关键约束

- **supportedModes**：`local` | `assistant`（无 SSH 远程 ppt；渲染发生在 app/CLI 本机）
- 画幅：widescreen 16:9（默认）/ standard 4:3；body 像素必须等于画幅英寸×96，由 `wrapSlideHtml` 保证
- 文字必须在 `<p>/<h*>/<ul>/<ol>` 内；文本标签不能带 bg/border/shadow；不支持 CSS 渐变；图片用绝对路径——违反在渲染期报错
- 单 job 建议 ≤ 50 页（软限制）
- HTML 契约变更须同步 `contracts/slide-html.md` 与 `index.ts` 的 `content`
- 前后端类型放 `shared/types/`，禁止重复定义

## 测试

- 单元：纯映射器 `applyBackground`/`applyElements`（假 pptx 断言调用）、`wrapSlideHtml`/`buildPreviewDocument`、`renderHtmlToPptx` 空输入拒绝
- 集成（有系统浏览器才跑）：真渲染 2 页 → 断言 pptx 非空、页数正确
- 手工：助手模式生成多页 deck，Canvas 预览 + soffice 转图核验 + PowerPoint/Keynote 打开

## 参考

- HTML 契约：`contracts/slide-html.md`
- Anthropic html2pptx（提取/映射/校验逻辑来源）：`skills/pptx` 的 `html2pptx.js`
