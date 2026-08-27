/**
 * 把 docx 里的字体灌进预览 HTML。
 * mammoth 只出语义标签，标题/正文会落到预览页写死的兜底字体上。
 */
import * as fs from 'fs'
import JSZip from 'jszip'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WordPreviewFonts')

export interface PreviewFont {
  family?: string
  size?: string
  weight?: string
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

interface RawStyle {
  styleId: string
  basedOnId?: string
  isDefault: boolean
  font?: string
  size?: string
  weight?: string
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
      weight: run.weight
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
    weight: raw.weight ?? base.weight
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
      weight: run.weight ?? fromStyle.weight
    })
  }
  return fonts
}

export function applyFontsToHtml(html: string, fonts: PreviewFont[]): string {
  const tags = html.match(/<(p|h[1-6])(\s[^>]*)?>/gi) || []
  if (tags.length !== fonts.length) return html

  let i = 0
  return html.replace(/<(p|h[1-6])(\s[^>]*)?>/gi, (full, tag: string, attrs = '') => {
    const font = fonts[i++]
    if (!font?.family && !font?.size && !font?.weight) return full

    const styleMatch = attrs.match(/style="([^"]*)"/)
    const existing = (styleMatch?.[1] || '').replace(/;+$/, '')
    const parts = existing ? [existing] : []
    if (font.family && !existing.includes('font-family')) parts.push(`font-family:${font.family}`)
    if (font.size && !existing.includes('font-size')) parts.push(`font-size:${font.size}`)
    if (font.weight && !existing.includes('font-weight')) parts.push(`font-weight:${font.weight}`)
    if (parts.length === 0 || (parts.length === 1 && existing)) return full

    const styleAttr = `style="${parts.join(';')}"`
    if (styleMatch) {
      return `<${tag}${attrs.replace(/style="[^"]*"/, styleAttr)}>`
    }
    return `<${tag}${attrs} ${styleAttr}>`
  })
}

export async function enrichHtmlFonts(html: string, source: string | Buffer): Promise<string> {
  try {
    const buf = typeof source === 'string' ? fs.readFileSync(source) : source
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml')?.async('string')
    const stylesXml = await zip.file('word/styles.xml')?.async('string')
    if (!xml || !stylesXml) return html
    return applyFontsToHtml(html, collectParagraphFonts(xml, stylesXml))
  } catch (e) {
    log.warn('enrichHtmlFonts failed:', e)
    return html
  }
}
