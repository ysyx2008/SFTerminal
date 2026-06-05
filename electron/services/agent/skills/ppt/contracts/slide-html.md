# Slide HTML 契约

> Agent 写 HTML、转换器 `html-to-pptx.ts` 均以此为准。修改须同步 `../SPEC.md` 与 skill `content`。

## 文档结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>演示文稿标题</title>
  <!-- 可选：theme 默认由 ppt_from_html 的 theme 参数注入 -->
</head>
<body>
  <section class="slide" data-layout="title" data-theme="midnight" style="width:1600px;height:900px;background:#1E2761">
    <h1 style="color:#FFFFFF">主标题</h1>
    <p class="subtitle" style="color:#CADCFC">副标题 · 2026.06</p>
  </section>

  <section class="slide" data-layout="content" style="width:1600px;height:900px">
    <h2>章节标题</h2>
    <ul>
      <li>要点一</li>
      <li>要点二</li>
    </ul>
  </section>
</body>
</html>
```

也可只提交 `<body>` 内多个 `section.slide`（executor 自动包全文档）。

## 硬性规则

| 规则 | 说明 |
|------|------|
| 分页 | 每页必须是 `section.slide` 或 `div.slide` |
| 尺寸 | 每页 `style` 含 `width:1600px;height:900px`（16:9） |
| 版式 | 必须 `data-layout`，见下表 |
| 主题 | 可选 `data-theme`；与工具参数 `theme` 合并，页级优先 |
| 图片 | **绝对路径**或 `data:image/...`；禁止相对路径、`http(s)`（v1） |
| 禁止 | `<script>`、iframe、canvas、form、动画、`@keyframes` |

## data-layout（v1）

| 值 | 用途 |
|----|------|
| `title` | 封面 / 章节隔页 |
| `content` | 标题 + 列表/段落 |
| `two-column` | 左栏 `.col-left`，右栏 `.col-right`（文+图） |
| `stat-callout` | `.stat` + `data-value` / `.stat-label` |
| `image-bleed` | 半幅大图 + 文字区 |
| `closing` | 结语 / Q&A |

## 元素与样式（v1 支持子集）

- 文本：`h1`–`h3`、`p`、`ul/ol/li`
- 结构：`div.col-left`、`div.col-right`、`div.stat`
- 表格：`table` / `thead` / `tbody` / `tr` / `th` / `td`
- 图片：`img[src][alt]`
- 样式：仅 `background`/`background-color`、`color`、`font-size`（px→pt）、`text-align`
- **不支持**：flex/grid 自动排版、gradient、box-shadow、transform

## 图表

先 `load_skill("chart")` + `generate_chart`，将返回的 PNG **绝对路径**写入：

```html
<img src="/Users/.../agent-workspace/charts/q1.png" alt="Q1 营收" />
```

## 设计提醒（摘要）

- 每页至少一个视觉元素（图、表、大数字、形状），避免纯白 bullet 页
- 标题 36pt+、正文 14–16pt；正文左对齐，仅标题可居中
- 勿在标题下加装饰线（AI 幻灯片常见丑点）
- 配色用 `data-theme` 或 skill 预设，勿全用默认蓝

完整配色表与 QA 流程见 skill `content`（摘录 Anthropic pptx SKILL.md）。

## Canvas 预览

同一份 HTML 即预览源：在助手模式右侧 Canvas 按 16:9 缩放纵向排列各 `.slide`。预览为浏览器渲染，与 PPTX 在字体换行上可能略有差异；以导出 `.pptx` 为准。
