/**
 * Canvas 预览：把每页 slide 包成等比缩放的 iframe，所见即所得地展示导出前的 HTML。
 * 每个 iframe 用与导出完全相同的 wrapper 渲染，确保预览 ≈ 导出。
 *
 * 缩放用纯 CSS 容器查询（container query）实现，不依赖脚本——因为承载预览的
 * SlidesRenderer iframe 是 sandbox="allow-same-origin"（无 allow-scripts），
 * 任何 <script> 都会被拦截。scale = 100cqw / 画布宽。
 */

import { DECK_SIZES, wrapSlideHtml, type DeckSize } from './html-render-pptx'

function escapeAttr(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** 完整 HTML 文档，供 Canvas iframe srcdoc 使用 */
export function buildPreviewDocument(
  slides: string[],
  css: string,
  size: DeckSize = 'widescreen'
): string {
  const spec = DECK_SIZES[size]
  const frames = slides
    .map((inner, i) => {
      const doc = escapeAttr(wrapSlideHtml(inner, css, spec))
      return `<div class="slide-card">
  <span class="slide-no">${i + 1} / ${slides.length}</span>
  <iframe class="slide-frame" width="${spec.px}" height="${spec.pxH}"
    srcdoc="${doc}" sandbox="allow-same-origin" scrolling="no" loading="lazy"></iframe>
</div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{background:#1a1a1e;padding:20px 16px 48px;font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;}
  .hint{text-align:center;color:#888;font-size:12px;margin:0 0 16px;}
  .deck{max-width:920px;margin:0 auto;container-type:inline-size;}
  .slide-card{
    position:relative;width:100%;aspect-ratio:${spec.px} / ${spec.pxH};
    margin:0 auto 20px;border-radius:10px;overflow:hidden;
    box-shadow:0 8px 32px rgba(0,0,0,.45);background:#fff;
  }
  .slide-no{
    position:absolute;top:10px;right:14px;z-index:2;
    font-size:12px;color:#fff;opacity:.65;
    background:rgba(0,0,0,.35);padding:2px 8px;border-radius:10px;
  }
  .slide-frame{
    width:${spec.px}px;height:${spec.pxH}px;border:none;display:block;
    transform-origin:top left;
    transform:scale(calc(100cqw / ${spec.px}px));
  }
</style>
</head>
<body>
<p class="hint">共 ${slides.length} 页 · 向下滚动预览 · 最终以 PowerPoint 打开导出文件为准</p>
<div class="deck">${frames}</div>
</body>
</html>`
}
