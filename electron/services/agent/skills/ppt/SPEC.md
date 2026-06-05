# PPT 技能 (ppt skill)

> Last verified: 2026-06-05

## 职责

为 Agent 提供生成「原生可编辑」`.pptx` 演示文稿的能力，单一路线 **html2pptx**（对标 [Anthropic pptx skill](https://github.com/anthropics/skills/tree/main/skills/pptx) 现行做法）：

1. AI 写 **HTML**（每页一段 body 内联 HTML，绝对定位排版）
2. 用**真实 Chromium** 渲染该页，遍历 DOM 读 `getBoundingClientRect` + `getComputedStyle`
3. 把每个元素映射成**原生 PptxGenJS 元素**（文本 / 列表 / 卡片 shape / 图片 / 边框线）——文字可编辑，布局由浏览器排版，从根上避免 AI 手算坐标导致的重叠/错乱
4. 渲染期**内置校验即 QA**：内容溢出、CSS 渐变、文本元素带背景/边框/阴影、div 裸文本、手敲项目符号——全部按页报错，引导 AI 改 HTML 重试
5. 同一份 HTML 通过 `CanvasData`（`renderer: 'html'` → `SlidesRenderer`）推送到助手 Canvas 预览（每页一个等比缩放 iframe，所见即所得）

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
| `preview.ts` | Canvas 预览文档：每页一个等比缩放 iframe（与导出同 wrapper，WYSIWYG） |
| `contracts/slide-html.md` | HTML 契约单一数据源（开发文档；AI 运行时看 `index.ts` content） |
| `__tests__/html-to-pptx.test.ts` | 纯映射器单测 + 浏览器可用时的真渲染集成测试 |

## 公开 API（工具）

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `ppt_from_html` | 写 HTML 幻灯片 → 原生可编辑 `.pptx` + Canvas 预览 | `path`（.pptx）、`slides`（每页 body 内联 HTML 数组，必填）、`css`（共享样式）、`size`（widescreen/standard）、`title` |

**输入模型**：`slides` 每项是一页的 body 内联 HTML（不写 `<html>/<head>/<body>`）；`css` 是所有页共享的 `<style>` 文本。系统用 `wrapSlideHtml` 包成完整文档、把 body 固定为画幅尺寸（widescreen 1280×720px = 13.333"×7.5"，standard 960×720px = 10"×7.5"，96 px/in）。

## 数据流

```
AI 写 css + slides[]
    ├─► 写 deck.html（预览文档，与 .pptx 同名）——即使导出失败也保留供改 HTML
    ├─► renderSlides：每页 wrapSlideHtml → 隐藏浏览器渲染 → 提取脚本 → SlideData
    ├─► 聚合每页 errors；有错 → PptValidationError（逐页问题回传，AI 改后重试，不写 pptx）
    ├─► 无错 → PptxGenJS：每页 addSlide + applyBackground + applyElements → writeFile
    └─► tool_result + canvasData { renderer:'html', content: 预览文档, filePath: deck.html }
```

## 元素映射（提取脚本 → PptxGenJS）

| HTML | PPT 元素 | 说明 |
|---|---|---|
| body 背景色 | `slide.background` | CSS 渐变不支持（报错，用纯色或 `.bg` div） |
| `<p>/<h1>-<h6>` | 文本框 | 读 font/color/align/lineSpacing/位置；支持 `<b><i><u><span>` 行内格式 |
| `<ul>/<ol>` | 项目符号文本块 | `<li>` → bullet run |
| `<div>`（带 bg/border/radius/shadow） | 形状（rect/roundRect） + 可能的边框线 | 卡片/色块；子文本元素独立渲染在上层 |
| `<img>` | 图片 | 绝对路径 / `file://`；图表先 chart 技能出 PNG |
| `class="placeholder"` | 占位坐标 | 供后续图表插入（预留） |

## Canvas 预览

- `renderer: 'html'`（`shared/types/canvas.ts`），前端 `SlidesRenderer.vue`（iframe srcdoc）+ `CanvasPanel.vue` 挂载
- `content`：完整 HTML 文档，每页一个 `width×height` 的子 iframe（srcdoc = 与导出同 wrapper），JS 等比 `scale` 适配容器宽 → 所见即所得
- `filePath`：保存的 `deck.html` 绝对路径 → 标题栏「打开 / 在文件夹中显示」
- WYSIWYG 边界：预览用真实浏览器渲染，与导出走同一 wrapper，偏差极小；最终以 PowerPoint 打开为准

## 依赖

| 依赖 | 用途 |
|------|------|
| `pptxgenjs` | 写 `.pptx` |
| `playwright-core` + `browser/detector` | 渲染后端（headless 系统浏览器，独立进程） |
| `fs` / `os` / `path` | 临时 HTML、deck.html、pptx |
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
