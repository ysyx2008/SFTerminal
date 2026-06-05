/**
 * Slide HTML 解析辅助（node-html-parser，避免 jsdom 拉取 canvas 原生模块）
 */

import * as fs from 'fs'
import * as path from 'path'
import { parse, type HTMLElement } from 'node-html-parser'
import type { PptTheme } from './themes'
import { resolveTheme, slideBackground } from './themes'

export type SlideElement = HTMLElement

export const SLIDE_WIDTH_PX = 1600
export const SLIDE_HEIGHT_PX = 900
export const MAX_SLIDES = 50

export interface ParsedSlide {
  element: SlideElement
  layout: string
  themeId: string | null
  background: string
}

export function normalizeHtmlDocument(html: string): string {
  const trimmed = html.trim()
  if (/<html[\s>]/i.test(trimmed)) return trimmed
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/></head><body>${trimmed}</body></html>`
}

export function parseSlidesFromHtml(html: string): ParsedSlide[] {
  const docHtml = normalizeHtmlDocument(html)
  const root = parse(docHtml)
  const nodes = root.querySelectorAll('section.slide, div.slide')
  if (!nodes.length) {
    throw new Error('未找到任何 section.slide / div.slide 元素')
  }
  if (nodes.length > MAX_SLIDES) {
    throw new Error(`幻灯片数量 ${nodes.length} 超过上限 ${MAX_SLIDES}`)
  }

  const slides: ParsedSlide[] = []
  for (const el of nodes) {
    const layout = (el.getAttribute('data-layout') || 'content').toLowerCase()
    const themeId = el.getAttribute('data-theme')
    const style = el.getAttribute('style')
    const inlineBg =
      parseStyleColor(style, 'background') || parseStyleColor(style, 'background-color')
    slides.push({
      element: el,
      layout,
      themeId,
      background: inlineBg || '',
    })
  }
  return slides
}

export { buildPreviewDocument } from './preview-html'

export function resolveThemeForSlide(
  globalThemeId: string | undefined,
  slide: ParsedSlide
): PptTheme {
  return resolveTheme(globalThemeId, slide.themeId)
}

export function effectiveSlideBg(theme: PptTheme, slide: ParsedSlide): string {
  return slide.background || slideBackground(theme, slide.layout)
}

export function hasClass(el: SlideElement, className: string): boolean {
  const list = el.classNames
  if (list?.length) return list.includes(className)
  const raw = el.getAttribute('class')
  if (!raw) return false
  return raw.split(/\s+/).includes(className)
}

export function parseStyleColor(style: string | null | undefined, prop: string): string | undefined {
  if (!style) return undefined
  const re = new RegExp(`${prop}\\s*:\\s*([^;]+)`, 'i')
  const m = style.match(re)
  if (!m) return undefined
  return normalizeHexColor(m[1].trim())
}

export function normalizeHexColor(raw: string): string | undefined {
  let c = raw.trim()
  if (c.startsWith('rgb')) return undefined
  if (c.startsWith('#')) c = c.slice(1)
  if (/^[0-9A-Fa-f]{6}$/.test(c)) return c.toUpperCase()
  if (/^[0-9A-Fa-f]{3}$/.test(c)) {
    return (c[0] + c[0] + c[1] + c[1] + c[2] + c[2]).toUpperCase()
  }
  return undefined
}

export function parseFontSizePt(style: string | null | undefined, fallback: number): number {
  if (!style) return fallback
  const m = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i)
  if (m) return Math.round(parseFloat(m[1]) * 0.75)
  const pt = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*pt/i)
  if (pt) return Math.round(parseFloat(pt[1]))
  return fallback
}

export function textColorFromElement(el: SlideElement, fallback: string): string {
  const fromSelf = parseStyleColor(el.getAttribute('style'), 'color')
  if (fromSelf) return fromSelf
  const styled = el.querySelectorAll('[style]')
  for (const child of styled) {
    const style = child.getAttribute('style')
    if (style?.includes('color')) {
      const c = parseStyleColor(style, 'color')
      if (c) return c
    }
  }
  return fallback
}

export function getText(el: SlideElement | null | undefined): string {
  if (!el) return ''
  return el.text.replace(/\s+/g, ' ').trim()
}

export function resolveImagePath(src: string, baseDir: string): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('data:image/')) return trimmed
  if (trimmed.startsWith('file://')) {
    const p = trimmed.replace(/^file:\/\//, '')
    return fs.existsSync(p) ? p : null
  }
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed)
  return fs.existsSync(abs) ? abs : null
}

export function collectBulletItems(root: SlideElement): string[] {
  const items: string[] = []
  for (const li of root.querySelectorAll('ul > li, ol > li')) {
    const t = getText(li)
    if (t) items.push(t)
  }
  if (!items.length) {
    for (const li of root.querySelectorAll('li')) {
      const t = getText(li)
      if (t) items.push(t)
    }
  }
  return items
}

/** 仅直接子级 p（替代 :scope > p） */
export function directParagraphs(root: SlideElement): SlideElement[] {
  const out: SlideElement[] = []
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue
    const el = child as SlideElement
    if (el.tagName?.toUpperCase() === 'P') out.push(el)
  }
  return out
}
