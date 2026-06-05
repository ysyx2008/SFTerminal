/**
 * data-layout → PptxGenJS 映射
 */

import type { ParsedSlide } from './html-parse'
import {
  collectBulletItems,
  directParagraphs,
  effectiveSlideBg,
  getText,
  hasClass,
  parseFontSizePt,
  resolveImagePath,
  resolveThemeForSlide,
  textColorFromElement,
  type SlideElement,
} from './html-parse'
import { bodyTextColor, type PptTheme } from './themes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxSlide = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxInstance = any

export interface LayoutContext {
  pptx: PptxInstance
  slide: PptxSlide
  parsed: ParsedSlide
  globalThemeId?: string
  mediaBaseDir: string
}

const MARGIN = 0.5
const ACCENT_BAR_W = 0.1
const TEXT_INSET = MARGIN + ACCENT_BAR_W + 0.12
const CONTENT_W = 10 - TEXT_INSET - MARGIN

function applyBackground(ctx: LayoutContext, theme: PptTheme): void {
  const bg = effectiveSlideBg(theme, ctx.parsed)
  ctx.slide.background = { color: bg }
}

/** 内容页左侧色条（非标题下划线，避免 AI 幻灯片俗套） */
function addAccentBar(ctx: LayoutContext, theme: PptTheme): void {
  ctx.slide.addShape(ctx.pptx.shapes.RECTANGLE, {
    x: 0,
    y: 0,
    w: ACCENT_BAR_W,
    h: 5.625,
    fill: { color: theme.accent },
    line: { width: 0 },
  })
}

function contentMarginX(): number {
  return TEXT_INSET
}

function addTitleText(
  slide: PptxSlide,
  text: string,
  opts: { x: number; y: number; w: number; h: number; fontSize: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right'; fontFace?: string }
): void {
  if (!text) return
  slide.addText(text, {
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    fontSize: opts.fontSize,
    color: opts.color,
    bold: opts.bold ?? false,
    align: opts.align ?? 'left',
    valign: 'middle',
    fontFace: opts.fontFace ?? 'Arial',
    margin: 0,
  })
}

function addBullets(
  slide: PptxSlide,
  items: string[],
  opts: { x: number; y: number; w: number; h: number; fontSize: number; color: string; fontFace?: string }
): void {
  if (!items.length) return
  const runs = items.map((item, i) => ({
    text: item,
    options: {
      bullet: true,
      breakLine: i < items.length - 1,
      fontSize: opts.fontSize,
      color: opts.color,
      fontFace: opts.fontFace ?? 'Calibri',
      paraSpaceAfter: 8,
    },
  }))
  slide.addText(runs, {
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    valign: 'top',
    margin: 0,
    lineSpacing: 22,
  })
}

function addImageIfAny(
  slide: PptxSlide,
  root: SlideElement,
  baseDir: string,
  box: { x: number; y: number; w: number; h: number }
): void {
  const img = root.querySelector('img')
  if (!img) return
  const src = img.getAttribute('src') || ''
  const resolved = resolveImagePath(src, baseDir)
  if (!resolved) return
  slide.addImage({
    path: resolved,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    sizing: { type: 'contain', w: box.w, h: box.h },
  })
}

export function renderSlideLayout(ctx: LayoutContext): void {
  const theme = resolveThemeForSlide(ctx.globalThemeId, ctx.parsed)
  applyBackground(ctx, theme)

  switch (ctx.parsed.layout) {
    case 'title':
      renderTitle(ctx, theme, false)
      break
    case 'closing':
      renderTitle(ctx, theme, true)
      break
    case 'two-column':
      renderTwoColumn(ctx, theme)
      break
    case 'stat-callout':
      renderStatCallout(ctx, theme)
      break
    case 'image-bleed':
      renderImageBleed(ctx, theme)
      break
    case 'content':
    default:
      renderContent(ctx, theme)
      break
  }
}

function renderTitle(ctx: LayoutContext, theme: PptTheme, closing: boolean): void {
  const root = ctx.parsed.element
  const h1 = root.querySelector('h1')
  const sub = root.querySelector('p.subtitle, p.subtitle-line, .subtitle, p')
  const titleText = getText(h1) || getText(root.querySelector('h2')) || (closing ? '谢谢' : '')
  const subText = sub && sub !== h1 ? getText(sub) : ''

  const titleColor = h1 ? textColorFromElement(h1, theme.text) : theme.text
  const subColor = sub ? textColorFromElement(sub, theme.textMuted) : theme.textMuted
  const titleSize = h1 ? parseFontSizePt(h1.getAttribute('style'), 40) : 40

  addTitleText(ctx.slide, titleText, {
    x: MARGIN,
    y: closing ? 2.0 : 1.5,
    w: 10 - MARGIN * 2,
    h: 1.5,
    fontSize: Math.max(titleSize, 44),
    color: titleColor,
    bold: true,
    align: 'center',
    fontFace: theme.titleFont,
  })
  if (subText && subText !== titleText) {
    addTitleText(ctx.slide, subText, {
      x: MARGIN,
      y: closing ? 3.5 : 3.2,
      w: CONTENT_W,
      h: 0.8,
      fontSize: 18,
      color: subColor,
      align: 'center',
      fontFace: theme.bodyFont,
    })
  }
}

function renderContent(ctx: LayoutContext, theme: PptTheme): void {
  addAccentBar(ctx, theme)
  const bodyColor = bodyTextColor(theme, ctx.parsed.layout, ctx.parsed.background)
  const root = ctx.parsed.element
  const heading = root.querySelector('h1, h2, h3')
  const title = getText(heading)
  const titleColor = heading ? textColorFromElement(heading, theme.primary) : theme.primary
  const mx = contentMarginX()
  const cw = 10 - mx - MARGIN
  let y = MARGIN

  if (title) {
    addTitleText(ctx.slide, title, {
      x: mx,
      y,
      w: cw,
      h: 0.75,
      fontSize: heading ? parseFontSizePt(heading.getAttribute('style'), 32) : 32,
      color: titleColor,
      bold: true,
      fontFace: theme.titleFont,
    })
    y += 0.95
  }

  const bullets = collectBulletItems(root)
  if (bullets.length) {
    addBullets(ctx.slide, bullets, {
      x: mx,
      y,
      w: cw,
      h: 5.625 - y - MARGIN,
      fontSize: 18,
      color: bodyColor,
      fontFace: theme.bodyFont,
    })
    return
  }

  const paragraphs: string[] = []
  for (const p of directParagraphs(root)) {
    if (hasClass(p, 'subtitle')) continue
    const t = getText(p)
    if (t) paragraphs.push(t)
  }
  if (paragraphs.length) {
    const runs = paragraphs.map((p, i) => ({
      text: p,
      options: { breakLine: i < paragraphs.length - 1, fontSize: 18, color: bodyColor, paraSpaceAfter: 6 },
    }))
    ctx.slide.addText(runs, {
      x: mx,
      y,
      w: cw,
      h: 5.625 - y - MARGIN,
      fontFace: theme.bodyFont,
      valign: 'top',
      margin: 0,
      lineSpacing: 22,
    })
  }

  addImageIfAny(ctx.slide, root, ctx.mediaBaseDir, {
    x: 5.6,
    y: 1.15,
    w: 3.9,
    h: 3.9,
  })
}

function renderTwoColumn(ctx: LayoutContext, theme: PptTheme): void {
  addAccentBar(ctx, theme)
  const bodyColor = bodyTextColor(theme, ctx.parsed.layout, ctx.parsed.background)
  const root = ctx.parsed.element
  const heading = root.querySelector('h1, h2')
  const title = getText(heading)
  const mx = contentMarginX()
  let y = MARGIN
  if (title && heading) {
    addTitleText(ctx.slide, title, {
      x: mx,
      y,
      w: 10 - mx - MARGIN,
      h: 0.7,
      fontSize: 30,
      color: textColorFromElement(heading, theme.primary),
      bold: true,
      fontFace: theme.titleFont,
    })
    y += 0.8
  }

  const left = root.querySelector('.col-left') || root
  const right = root.querySelector('.col-right')
  const colY = y
  const colH = 5.625 - colY - MARGIN
  const leftW = 4.0
  const rightX = mx + leftW + 0.3

  const leftBullets = collectBulletItems(left)
  if (leftBullets.length) {
    addBullets(ctx.slide, leftBullets, {
      x: mx,
      y: colY,
      w: leftW,
      h: colH,
      fontSize: 15,
      color: bodyColor,
      fontFace: theme.bodyFont,
    })
  } else {
    const ps: string[] = []
    left.querySelectorAll('p').forEach((p) => {
      const t = getText(p)
      if (t) ps.push(t)
    })
    if (ps.length) {
      ctx.slide.addText(ps.join('\n'), {
        x: mx,
        y: colY,
        w: leftW,
        h: colH,
        fontSize: 15,
        color: bodyColor,
        fontFace: theme.bodyFont,
        valign: 'top',
        margin: 0,
      })
    }
  }

  if (right) {
    addImageIfAny(ctx.slide, right, ctx.mediaBaseDir, {
      x: rightX,
      y: colY,
      w: 4.4,
      h: colH,
    })
    if (!right.querySelector('img')) {
      const rb = collectBulletItems(right)
      if (rb.length) {
        addBullets(ctx.slide, rb, {
          x: rightX,
          y: colY,
          w: 4.4,
          h: colH,
          fontSize: 15,
          color: bodyColor,
          fontFace: theme.bodyFont,
        })
      }
    }
  }
}

function renderStatCallout(ctx: LayoutContext, theme: PptTheme): void {
  addAccentBar(ctx, theme)
  const root = ctx.parsed.element
  const statEl = root.querySelector('.stat, [data-value]')
  const labelEl = root.querySelector('.stat-label, p')
  const value =
    statEl?.getAttribute('data-value') ||
    getText(statEl) ||
    getText(root.querySelector('h1'))
  const label = getText(labelEl) || getText(root.querySelector('h2, p'))

  addTitleText(ctx.slide, value, {
    x: MARGIN,
    y: 1.5,
    w: CONTENT_W,
    h: 1.8,
    fontSize: 60,
    color: theme.primary,
    bold: true,
    align: 'center',
    fontFace: theme.titleFont,
  })
  if (label && label !== value) {
    addTitleText(ctx.slide, label, {
      x: MARGIN,
      y: 3.5,
      w: CONTENT_W,
      h: 0.9,
      fontSize: 20,
      color: theme.textMuted,
      align: 'center',
      fontFace: theme.bodyFont,
    })
  }
}

function renderImageBleed(ctx: LayoutContext, theme: PptTheme): void {
  addAccentBar(ctx, theme)
  const bodyColor = bodyTextColor(theme, ctx.parsed.layout, ctx.parsed.background)
  const root = ctx.parsed.element
  const img = root.querySelector('img')
  if (img) {
    const src = img.getAttribute('src') || ''
    const resolved = resolveImagePath(src, ctx.mediaBaseDir)
    if (resolved) {
      ctx.slide.addImage({
        path: resolved,
        x: 5.0,
        y: 0.4,
        w: 4.8,
        h: 4.9,
        sizing: { type: 'cover', w: 4.8, h: 4.9 },
      })
    }
  }

  const textRoot = root.querySelector('.col-left') || root
  const heading = textRoot.querySelector('h1, h2')
  const title = getText(heading)
  let y = MARGIN
  if (title && heading) {
    addTitleText(ctx.slide, title, {
      x: MARGIN,
      y,
      w: 4.2,
      h: 0.7,
      fontSize: 26,
      color: textColorFromElement(heading, theme.primary),
      bold: true,
      fontFace: theme.titleFont,
    })
    y += 0.8
  }
  const bullets = collectBulletItems(textRoot)
  if (bullets.length) {
    addBullets(ctx.slide, bullets, {
      x: MARGIN,
      y,
      w: 4.2,
      h: 4.5,
      fontSize: 15,
      color: bodyColor,
      fontFace: theme.bodyFont,
    })
  }
}
