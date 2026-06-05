# Slide HTML 契约（html2pptx 路线）

> AI 运行时看 `index.ts` 的 skill `content`；本文件是开发侧的完整数据源。

## 模型

`ppt_from_html({ path, slides, css?, size?, title? })`

- `slides[i]` = **第 i 页的 body 内联 HTML**（不写 `<html>/<head>/<body>`）。
- `css` = 所有页共享的 `<style>` 文本。
- 系统用 `wrapSlideHtml` 把每页包成完整文档，并把 `body` 固定为画幅尺寸：
  - `widescreen`（默认，16:9）：`1280 × 720 px` = `13.333" × 7.5"`
  - `standard`（4:3）：`960 × 720 px` = `10" × 7.5"`
  - 换算：`96 px = 1 inch`。

## 排版规则

1. **绝对定位**：元素用 `position:absolute; left/top/width`（px）。浏览器算最终坐标，映射时按 `getBoundingClientRect` 转英寸。
2. **文字载体**：所有文字必须在 `<p>/<h1>-<h6>/<ul>/<ol>` 内。`<div>` 内不得有裸文本节点。
3. **卡片/色块**：用 `<div>`，可带 `background` / `border`（统一边框→形状描边；非统一→四条线）/ `border-radius`（→ rectRadius）/ `box-shadow`（外阴影→ PPT 阴影）。文字放进 div 内的 `<p>/<h*>`。
4. **整页底色**：每页第一个 `<div class="bg" style="background:#xxx"></div>`（`.bg` 已在 BASE_CSS 里 `position:absolute;inset:0`），或在 `css` 里写 `body{background:#xxx}`（→ slide.background）。
5. **列表**：`<ul>/<ol><li>`，不要手敲「• - *」。`<li>` 内可用 `<b><i><u><span>` 行内格式。
6. **图片**：`<img src="绝对路径或 file://">`；图表先 `load_skill("chart")` 出 PNG 再插入。
7. **行内格式**：`<b>/<strong>` 粗体、`<i>/<em>` 斜体、`<u>` 下划线、`<span style="color/font-size">` 局部样式。

## 渲染期会报错的情况（QA）

- 内容超出页面（横/纵向溢出，底部应留白 ≥ 0.5"）
- body / div 用 **CSS 渐变**（不支持，用纯色）
- **文本标签**（p/h*/ul/ol/li）带 `background` / `border` / `box-shadow`
- `<div>` 里有未包裹的裸文本
- 文本以项目符号字符开头（应用 `<ul>`）
- div 用 `background-image`（用 `<img>` 或纯色）

报错按页返回（「第 N 页：…」），AI 据此改对应页 HTML 重试。

## 坐标速记（widescreen 1280×720）

- 安全边距：四周 ~64px；标题区 top 64–120px；底部留白 ≥ 48px。
- 三卡片墙：`left = 80 / 470 / 860`，`width = 340`，`gap = 50`。
- 两栏：`left = 80 / 660`，`width = 540`，`gap = 40`。

## 设计规范

- 三明治：封面/结尾深底，内容页浅底。
- 每页一个视觉锚点（数字卡墙 / 图表 / 关键图），不要纯 bullet 墙。
- 标题 34–44px（封面 56px+）、正文 18–22px；强调色克制。
- 标题左侧短色条代替整条下划线；卡片对齐成网格，行列间距统一。
