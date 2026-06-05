/**
 * Canvas 预览：把每页 slide 包成等比缩放的 iframe，所见即所得地展示导出前的 HTML。
 * 每个 iframe 用与导出完全相同的 wrapper 渲染，确保预览 ≈ 导出。
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
    srcdoc="${doc}" sandbox="allow-same-origin" scrolling="no"></iframe>
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
  .deck{max-width:920px;margin:0 auto;}
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
    border:none;display:block;
    transform-origin:top left;
    /* 等比缩放：宽度自适应容器，scale 由 JS 计算 */
  }
</style>
</head>
<body>
<p class="hint">共 ${slides.length} 页 · 向下滚动预览 · 最终以 PowerPoint 打开导出文件为准</p>
<div class="deck">${frames}</div>
<script>
  function fit(){
    document.querySelectorAll('.slide-card').forEach(function(card){
      var frame = card.querySelector('.slide-frame');
      if(!frame) return;
      var scale = card.clientWidth / ${spec.px};
      frame.style.transform = 'scale(' + scale + ')';
    });
  }
  window.addEventListener('resize', fit);
  fit();
  // iframe 内容/字体加载后再 fit 一次
  setTimeout(fit, 120);
</script>
</body>
</html>`
}
