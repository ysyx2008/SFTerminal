/**
 * 把 docx 里的字体灌进预览 HTML。
 * mammoth 只出语义标签，标题/正文会落到预览页写死的兜底字体上。
 */
import * as fs from 'fs'
import JSZip from 'jszip'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WordPreviewFonts')

export type PreviewBlockKind = 'title' | 'heading' | 'body'

export interface PreviewFont {
  family?: string
  size?: string
  weight?: string
  /** 首行缩进。含 `0`：文档顶格时必须写出，否则预览页会按正文缩两字。 */
  indent?: string
  kind?: PreviewBlockKind
}

/** 本机常见别名。先写文档里的真名，后面是同族/系统代用，找不到再走 serif/sans。 */
const FONT_STACKS: Record<string, string> = {
  '方正小标宋简体': "'方正小标宋简体','方正小标宋','FZXiaoBiaoSong-B05S','STXiaoBiaoSong','华文中宋','STZhongsong','Songti SC',serif",
  '方正小标宋': "'方正小标宋','方正小标宋简体','FZXiaoBiaoSong-B05S','STXiaoBiaoSong','华文中宋','STZhongsong','Songti SC',serif",
  '仿宋': "'仿宋','仿宋_GB2312','STFangsong','FangSong','华文仿宋',serif",
  '仿宋_GB2312': "'仿宋_GB2312','仿宋','STFangsong','FangSong','华文仿宋',serif",
  '黑体': "'黑体','SimHei','STHeiti','Heiti SC','华文黑体',sans-serif",
  '楷体': "'楷体','楷体_GB2312','STKaiti','Kaiti SC','KaiTi','华文楷体',serif",
  '楷体_GB2312': "'楷体_GB2312','楷体','STKaiti','Kaiti SC','KaiTi','华文楷体',serif",
  '宋体': "'宋体','SimSun','Songti SC','STSong',serif"
}

const SANS_FACES = new Set([
  '微软雅黑',
  'Microsoft YaHei',
  'PingFang SC'
])

export function cssFontFamily(name: string): string {
  const stack = FONT_STACKS[name]
  if (stack) return stack
  for (const known of Object.values(FONT_STACKS)) {
    if (known.includes(`'${name}'`)) return known
  }
  const generic = SANS_FACES.has(name) ? 'sans-serif' : 'serif'
  return `'${name}',${generic}`
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag)
  return m?.[1]
}

function usableFont(name?: string): string | undefined {
  if (!name || name.includes('Theme') || name === 'zh-CN') return undefined
  const cleaned = name.replace(/['"\\;<>\n\r]/g, '').trim()
  return cleaned || undefined
}

function parseRunFonts(xml: string): { font?: string; size?: string; weight?: string } {
  const fontsTag = xml.match(/<w:rFonts\b[^>]*\/?>/)?.[0] ?? ''
  const eastAsia = usableFont(attr(fontsTag, 'w:eastAsia'))
  const ascii = usableFont(attr(fontsTag, 'w:ascii') || attr(fontsTag, 'w:hAnsi'))
  const szTag = xml.match(/<w:sz\s[^>]*\/?>/)?.[0] ?? ''
  const sz = attr(szTag, 'w:val')
  let weight: string | undefined
  if (/<w:b\s+w:val="(?:false|0)"/.test(xml)) weight = 'normal'
  else if (/<w:b\s*\/>|<w:b\s+w:val="(?:true|1)"/.test(xml)) weight = 'bold'
  return {
    font: eastAsia || ascii,
    size: sz ? `${parseInt(sz, 10) / 2}pt` : undefined,
    weight
  }
}

function parseFirstLineIndent(xml: string): string | undefined {
  const ind = xml.match(/<w:ind\b[^>]*\/?>/)?.[0]
  if (!ind) return undefined
  const chars = attr(ind, 'w:firstLineChars')
  if (chars !== undefined) {
    const n = parseInt(chars, 10)
    if (!Number.isFinite(n)) return undefined
    return n <= 0 ? '0' : `${n / 100}em`
  }
  const twips = attr(ind, 'w:firstLine')
  if (twips !== undefined) {
    const n = parseInt(twips, 10)
    if (!Number.isFinite(n)) return undefined
    return n <= 0 ? '0' : `${n / 20}pt`
  }
  return undefined
}

interface RawStyle {
  styleId: string
  basedOnId?: string
  isDefault: boolean
  font?: string
  size?: string
  weight?: string
  indent?: string
}

function parseStyleBlocks(stylesXml: string): Map<string, RawStyle> {
  const byId = new Map<string, RawStyle>()
  const blocks = stylesXml.match(/<w:style\s[\s\S]*?<\/w:style>/g) || []
  for (const block of blocks) {
    const styleId = attr(block, 'w:styleId')
    if (!styleId) continue
    const run = parseRunFonts(block)
    byId.set(styleId, {
      styleId,
      basedOnId: block.match(/<w:basedOn\s+w:val="([^"]+)"/)?.[1],
      isDefault: /w:default="1"/.test(block),
      font: run.font,
      size: run.size,
      weight: run.weight,
      indent: parseFirstLineIndent(block)
    })
  }
  return byId
}

function parseDocDefaults(stylesXml: string): PreviewFont {
  const docDefaults = stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? ''
  const run = parseRunFonts(docDefaults)
  return toPreviewFont(run.font, run.size, run.weight)
}

function toPreviewFont(font?: string, size?: string, weight?: string): PreviewFont {
  const out: PreviewFont = {}
  if (font) out.family = cssFontFamily(font)
  if (size) out.size = size
  if (weight) out.weight = weight
  return out
}

function resolveStyle(
  styleId: string,
  byId: Map<string, RawStyle>,
  cache: Map<string, PreviewFont>,
  defaults: PreviewFont
): PreviewFont {
  const cached = cache.get(styleId)
  if (cached) return cached

  const raw = byId.get(styleId)
  if (!raw) {
    cache.set(styleId, defaults)
    return defaults
  }

  let base = defaults
  if (raw.basedOnId && raw.basedOnId !== styleId) {
    base = resolveStyle(raw.basedOnId, byId, cache, defaults)
  }
  const resolved: PreviewFont = {
    family: raw.font ? cssFontFamily(raw.font) : base.family,
    size: raw.size ?? base.size,
    weight: raw.weight ?? base.weight,
    indent: raw.indent ?? base.indent
  }
  cache.set(styleId, resolved)
  return resolved
}

export function parseStyleFontMap(stylesXml: string): {
  byId: Map<string, PreviewFont>
  defaultStyleId: string
} {
  const raw = parseStyleBlocks(stylesXml)
  const defaults = parseDocDefaults(stylesXml)
  const cache = new Map<string, PreviewFont>()
  const byId = new Map<string, PreviewFont>()
  let defaultStyleId = 'Normal'
  for (const style of raw.values()) {
    if (style.isDefault) defaultStyleId = style.styleId
    byId.set(style.styleId, resolveStyle(style.styleId, raw, cache, defaults))
  }
  if (!byId.has('Normal') && defaults.family) {
    byId.set('Normal', defaults)
  }
  return { byId, defaultStyleId }
}

/** mammoth 会丢掉空段；列表项变成 <li> 而不是 <p>/<h>。这些段不进配对序列。 */
function mapsToPreviewBlock(para: string): boolean {
  const texts = [...para.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)]
  if (!texts.some(m => m[1].trim())) return false
  const style = para.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] || ''
  const heading = /^(Title|Heading[1-6])$/i.test(style)
  const list = /<w:numPr[\s>]/.test(para) || /^List/i.test(style)
  return heading || !list
}

function blockKind(styleId: string): PreviewBlockKind {
  if (/^Title$/i.test(styleId)) return 'title'
  if (/^Heading[1-6]$/i.test(styleId)) return 'heading'
  return 'body'
}

export function collectParagraphFonts(
  documentXml: string,
  stylesXml: string
): PreviewFont[] {
  const { byId, defaultStyleId } = parseStyleFontMap(stylesXml)
  const defaults = byId.get(defaultStyleId) || byId.get('Normal') || {}
  const fonts: PreviewFont[] = []

  for (const m of documentXml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const para = m[0]
    if (!mapsToPreviewBlock(para)) continue
    const pStyle = para.match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] || defaultStyleId
    const fromStyle = byId.get(pStyle) || defaults
    const firstTextRun = para.match(/<w:r\b[\s\S]*?<w:t[\s>][\s\S]*?<\/w:r>/)?.[0] ?? ''
    const run = parseRunFonts(firstTextRun)
    fonts.push({
      family: run.font ? cssFontFamily(run.font) : fromStyle.family,
      size: run.size ?? fromStyle.size,
      weight: run.weight ?? fromStyle.weight,
      indent: parseFirstLineIndent(para) ?? fromStyle.indent ?? '0',
      kind: blockKind(pStyle)
    })
  }
  return fonts
}

export function applyFontsToHtml(html: string, fonts: PreviewFont[]): string {
  const titles = fonts.filter(f => f.kind === 'title')
  const headings = fonts.filter(f => f.kind === 'heading')
  const bodies = fonts.filter(f => !f.kind || f.kind === 'body')
  const useBuckets = fonts.some(f => f.kind)
  let ti = 0
  let hi = 0
  let bi = 0
  let i = 0

  return html.replace(/<(p|h[1-6])(\s[^>]*)?>/gi, (full, tag: string, attrs = '') => {
    const isTitle = tag.toLowerCase() === 'h1' && /(?:^|\s)class="[^"]*document-title/.test(attrs)
    const font = useBuckets
      ? (isTitle ? titles[ti++] : /^h[1-6]$/i.test(tag) ? headings[hi++] : bodies[bi++])
      : fonts[i++]
    if (!font?.family && !font?.size && !font?.weight && font?.indent === undefined) return full

    const styleMatch = attrs.match(/style="([^"]*)"/)
    const existing = (styleMatch?.[1] || '').replace(/;+$/, '')
    const parts = existing ? [existing] : []
    if (font.family && !existing.includes('font-family')) parts.push(`font-family:${font.family}`)
    if (font.size && !existing.includes('font-size')) parts.push(`font-size:${font.size}`)
    if (font.weight && !existing.includes('font-weight')) parts.push(`font-weight:${font.weight}`)
    if (font.indent !== undefined && !existing.includes('text-indent')) parts.push(`text-indent:${font.indent}`)
    if (parts.length === 0 || (parts.length === 1 && existing)) return full

    const styleAttr = `style="${parts.join(';')}"`
    if (styleMatch) {
      return `<${tag}${attrs.replace(/style="[^"]*"/, styleAttr)}>`
    }
    return `<${tag}${attrs} ${styleAttr}>`
  })
}

const DXA_PER_MM = 1440 / 25.4

export interface PreviewPageBox {
  widthMm: number
  heightMm: number
  marginTopMm: number
  marginRightMm: number
  marginBottomMm: number
  marginLeftMm: number
}

function dxaToMm(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.round((n / DXA_PER_MM) * 10) / 10
}

export function parsePreviewPageBox(documentXml: string): PreviewPageBox {
  const sectPr = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)?.pop() ?? ''
  const pgMar = sectPr.match(/<w:pgMar[^>]*>/)?.[0] ?? ''
  const pgSz = sectPr.match(/<w:pgSz[^>]*>/)?.[0] ?? ''
  return {
    widthMm: dxaToMm(attr(pgSz, 'w:w'), 210),
    heightMm: dxaToMm(attr(pgSz, 'w:h'), 297),
    marginTopMm: dxaToMm(attr(pgMar, 'w:top'), 25.4),
    marginRightMm: dxaToMm(attr(pgMar, 'w:right'), 25.4),
    marginBottomMm: dxaToMm(attr(pgMar, 'w:bottom'), 25.4),
    marginLeftMm: dxaToMm(attr(pgMar, 'w:left'), 25.4)
  }
}

export function wrapPreviewPage(html: string, box: PreviewPageBox): string {
  if (/class="sf-word-page"/.test(html)) return html
  const style = [
    `--sf-page-w:${box.widthMm}mm`,
    `--sf-page-h:${box.heightMm}mm`,
    `--sf-m-t:${box.marginTopMm}mm`,
    `--sf-m-r:${box.marginRightMm}mm`,
    `--sf-m-b:${box.marginBottomMm}mm`,
    `--sf-m-l:${box.marginLeftMm}mm`
  ].join(';')
  return `<div class="sf-word-page" style="${style}">${html}</div>`
}

export async function enrichHtmlFonts(html: string, source: string | Buffer): Promise<string> {
  try {
    const buf = typeof source === 'string' ? fs.readFileSync(source) : source
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml')?.async('string')
    const stylesXml = await zip.file('word/styles.xml')?.async('string')
    if (!xml) return html
    const styled = stylesXml
      ? applyFontsToHtml(html, collectParagraphFonts(xml, stylesXml))
      : html
    return wrapPreviewPage(styled, parsePreviewPageBox(xml))
  } catch (e) {
    log.warn('enrichHtmlFonts failed:', e)
    return html
  }
}
