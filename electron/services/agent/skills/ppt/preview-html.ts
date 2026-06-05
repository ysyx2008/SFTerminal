/**
 * Canvas 预览 HTML：注入主题样式，且仅输出可放入 iframe srcdoc 的完整文档
 */

import { parse } from 'node-html-parser'
import { normalizeHtmlDocument } from './html-parse'
import { PPT_THEMES, type PptTheme } from './themes'

const PREVIEW_BASE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  background: #1a1a1e;
  padding: 20px 16px 40px;
}
.deck-preview { max-width: 920px; margin: 0 auto; }
.deck-preview .slide {
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 0 auto 20px;
  padding: 8% 9%;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,.45);
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.deck-preview .slide::before {
  content: attr(data-slide-index);
  position: absolute;
  top: 12px;
  right: 16px;
  font-size: 12px;
  opacity: 0.55;
  font-weight: 500;
}
.deck-preview .slide[data-layout="title"] h1,
.deck-preview .slide[data-layout="closing"] h1 {
  font-size: clamp(28px, 4.2vw, 44px);
  font-weight: 700;
  margin: 0 0 0.35em;
  line-height: 1.15;
  text-align: center;
}
.deck-preview .slide[data-layout="title"] .subtitle,
.deck-preview .slide[data-layout="title"] p.subtitle,
.deck-preview .slide[data-layout="closing"] p {
  font-size: clamp(14px, 2vw, 20px);
  margin: 0;
  text-align: center;
  opacity: 0.88;
}
.deck-preview .slide[data-layout="content"] h2,
.deck-preview .slide[data-layout="two-column"] h2,
.deck-preview .slide[data-layout="image-bleed"] h2 {
  font-size: clamp(22px, 3.2vw, 32px);
  font-weight: 700;
  margin: 0 0 0.6em;
  padding-left: 14px;
  border-left: 5px solid var(--accent, #0D9488);
}
.deck-preview .slide ul {
  margin: 0;
  padding-left: 1.35em;
  font-size: clamp(15px, 2.2vw, 20px);
  line-height: 1.55;
}
.deck-preview .slide li { margin-bottom: 0.35em; }
.deck-preview .slide .col-left { flex: 1; min-width: 0; }
.deck-preview .slide .col-right { flex: 1; min-width: 0; }
.deck-preview .slide[data-layout="two-column"] {
  flex-direction: row;
  gap: 6%;
  align-items: flex-start;
  justify-content: flex-start;
  padding-top: 10%;
}
.deck-preview .slide[data-layout="two-column"] h2 {
  position: absolute;
  top: 8%;
  left: 9%;
  right: 9%;
  padding-left: 14px;
}
.deck-preview .slide .stat {
  font-size: clamp(48px, 8vw, 72px);
  font-weight: 800;
  text-align: center;
  color: var(--primary, #1E2761);
  line-height: 1;
}
.deck-preview .slide .stat-label {
  text-align: center;
  font-size: clamp(16px, 2.4vw, 22px);
  margin-top: 0.5em;
  color: var(--muted, #64748B);
}
.deck-preview-hint {
  text-align: center;
  color: #888;
  font-size: 12px;
  margin-bottom: 16px;
}
`

function themeCssVars(theme: PptTheme): string {
  return [
    `--primary:#${theme.primary}`,
    `--accent:#${theme.accent}`,
    `--muted:#${theme.textMuted}`,
    `background:#${theme.background}`,
    `color:#${theme.text}`,
  ].join(';')
}

function themeCssVarsLight(theme: PptTheme): string {
  return [
    `--primary:#${theme.primary}`,
    `--accent:#${theme.accent}`,
    `--muted:#${theme.textMuted}`,
    `background:#${theme.backgroundAlt}`,
    `color:#${theme.text}`,
  ].join(';')
}

function applySlidePreviewAttrs(html: string): string {
  const root = parse(normalizeHtmlDocument(html))
  const body = root.querySelector('body') || root
  const slides = body.querySelectorAll('section.slide, div.slide')
  slides.forEach((slide, i) => {
    slide.setAttribute('data-slide-index', `${i + 1} / ${slides.length}`)
    const layout = (slide.getAttribute('data-layout') || 'content').toLowerCase()
    const themeId = (slide.getAttribute('data-theme') || 'simple').toLowerCase()
    const theme = PPT_THEMES[themeId] ?? PPT_THEMES.simple
    const vars =
      layout === 'title' || layout === 'closing' ? themeCssVars(theme) : themeCssVarsLight(theme)
    const existing = slide.getAttribute('style') || ''
    slide.setAttribute('style', `${existing};${vars}`)
  })
  return body.innerHTML
}

/** 完整 HTML 文档，供 Canvas iframe srcdoc 使用（勿用 v-html 注入） */
export function buildPreviewDocument(html: string): string {
  const bodyInner = applySlidePreviewAttrs(html)
  const slideCount = parse(normalizeHtmlDocument(html)).querySelectorAll('section.slide, div.slide').length
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>${PREVIEW_BASE_CSS}</style>
</head>
<body>
<p class="deck-preview-hint">共 ${slideCount} 页 · 向下滚动预览 · 导出以 PowerPoint 打开为准</p>
<div class="deck-preview">${bodyInner}</div>
</body>
</html>`
}
