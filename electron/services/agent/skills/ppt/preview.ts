/**
 * Canvas 预览：把整副 deck 渲染进「单个」iframe（HtmlRenderer 的 sandbox iframe）。
 *
 * 为什么不用「每页一个内层 iframe」：
 *   所有页本就共享同一份 css，没有隔离需求，因此直接把每页放进一个缩放的 .stage 容器，
 *   全程零脚本、零嵌套 iframe，控制台干净（也避免嵌套 srcdoc 子帧的 benign 脚本拦截警告）。
 *
 * 缩放：.slide-card 用容器查询（container query），.stage 固定画幅尺寸后
 *   transform:scale(calc(100cqw / 画幅宽))，纯 CSS，不依赖脚本（也不依赖 allow-same-origin）。
 *
 * 图片：sandbox iframe 无法加载 `/abs/path.png` 这类本地文件路径，会显示空白。
 *   渲染在 Node 主进程，这里直接读盘把本地图片内联成 data: URI，确保预览能显示。
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DECK_SIZES, type DeckSize } from './html-render-pptx'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PptPreview')

let cachedEchartsInline: string | null = null
let cachedChinaMapBootstrap: string | null = null

function resolveEchartsBundlePath(): string | null {
  const candidates = [
    path.join(process.cwd(), 'node_modules/echarts/dist/echarts.min.js'),
  ]
  try {
    candidates.push(path.join(app.getAppPath(), 'node_modules/echarts/dist/echarts.min.js'))
    if (app.isPackaged) {
      candidates.push(
        path.join(process.resourcesPath, 'app.asar/node_modules/echarts/dist/echarts.min.js')
      )
    }
  } catch {
    // CLI / 单元测试
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function resolveChartMapsDir(): string {
  try {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'chart-maps')
    }
    return path.join(app.getAppPath(), 'resources', 'chart-maps')
  } catch {
    return path.join(process.cwd(), 'resources', 'chart-maps')
  }
}

/** sandbox iframe CSP 禁止外链脚本；幻灯片若引用 CDN echarts，改由预览文档内联注入 */
function getInlineEchartsScript(): string {
  if (cachedEchartsInline) return cachedEchartsInline
  const bundlePath = resolveEchartsBundlePath()
  if (!bundlePath) {
    log.warn('echarts.min.js not found; PPT slides using CDN echarts will fail in preview')
    return ''
  }
  cachedEchartsInline = fs.readFileSync(bundlePath, 'utf8')
  return cachedEchartsInline
}

function slideUsesEcharts(html: string): boolean {
  return /echarts|registerMap|type\s*:\s*['"]map['"]/i.test(html)
}

function needsChinaMap(html: string): boolean {
  return /map\/js\/china|map\s*:\s*['"]china['"]|registerMap\s*\(\s*['"]china['"]/i.test(html)
}

/** 预览文档是否已内联 echarts 主包（>80KB 的无 src 脚本） */
function docHasEchartsBundle(html: string): boolean {
  const scripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || []
  return scripts.some(s => s.length > 80_000 && /echarts/i.test(s))
}

/** 去掉外链 <script src="https://...">，避免 sandbox iframe CSP 拦截 */
function stripExternalScriptTags(html: string): string {
  return html.replace(
    /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+["'][^>]*>\s*<\/script>/gi,
    ''
  )
}

/** DataV china.json → registerMap('china')，替代旧版 echarts china.js CDN */
function getChinaMapBootstrapScript(): string {
  if (cachedChinaMapBootstrap !== null) return cachedChinaMapBootstrap
  const chinaPath = path.join(resolveChartMapsDir(), 'china.json')
  if (!fs.existsSync(chinaPath)) {
    cachedChinaMapBootstrap = ''
    return ''
  }
  const geoJson = fs.readFileSync(chinaPath, 'utf8')
  cachedChinaMapBootstrap =
    `(function(){try{var g=${geoJson};` +
    `if(typeof echarts!=="undefined")` +
    `echarts.registerMap("china",g,{南海诸岛:{left:124,top:28,width:10}});` +
    `}catch(e){}})();`
  return cachedChinaMapBootstrap
}

function injectBeforeHeadClose(html: string, tags: string): string {
  if (!tags) return html
  return html.includes('</head>')
    ? html.replace('</head>', `${tags}\n</head>`)
    : `${tags}\n${html}`
}

/**
 * 修复已落盘 / 历史记录中的预览 HTML：去 CDN、内联 echarts、注册中国地图。
 * sandbox iframe 的 CSP 只允许 inline script，外链 jsDelivr 必失败。
 */
export function sanitizePreviewHtml(html: string): string {
  if (!html?.trim()) return html
  const needsEchartsLib = slideUsesEcharts(html)
  const needsChina = needsChinaMap(html)
  let out = stripExternalScriptTags(html)

  const headInject: string[] = []
  if (needsEchartsLib && !docHasEchartsBundle(out)) {
    const echartsScript = getInlineEchartsScript()
    if (echartsScript) {
      headInject.push(`<script>${echartsScript}<\/script>`)
    }
  }
  if (needsChina) {
    const chinaBootstrap = getChinaMapBootstrapScript()
    if (chinaBootstrap) {
      headInject.push(`<script>${chinaBootstrap}<\/script>`)
    }
  }
  if (headInject.length) {
    out = injectBeforeHeadClose(out, headInject.join('\n'))
  }
  return out
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

/** 单张图片内联上限（避免超大图把预览文档撑爆） */
const MAX_INLINE_BYTES = 8 * 1024 * 1024

function fileToDataUri(rawPath: string): string | null {
  let p = rawPath.trim()
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      p = p.replace(/^file:\/\//, '')
    }
  }
  // 仅处理本地绝对路径；http(s)/data: 原样保留
  if (!p.startsWith('/')) return null
  try {
    const stat = fs.statSync(p)
    if (!stat.isFile() || stat.size > MAX_INLINE_BYTES) return null
    const ext = (p.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    const b64 = fs.readFileSync(p).toString('base64')
    return `data:${mime};base64,${b64}`
  } catch (err) {
    log.warn('inline image failed:', rawPath, err)
    return null
  }
}

/** 把 <img src="本地路径"> / <img src='file://...'> 的本地图片替换为 data: URI */
function inlineLocalImages(html: string): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (whole, prefix: string, _q: string, dq?: string, sq?: string) => {
      const src = (dq ?? sq ?? '').trim()
      if (!src || src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
        return whole
      }
      const uri = fileToDataUri(src)
      return uri ? `${prefix}"${uri}"` : whole
    }
  )
}

/** 完整 HTML 文档，供 Canvas（SlidesRenderer）的 sandbox iframe srcdoc 使用 */
export function buildPreviewDocument(
  slides: string[],
  css: string,
  size: DeckSize = 'widescreen'
): string {
  const spec = DECK_SIZES[size]

  const cards = slides
    .map((inner, i) => {
      const body = stripExternalScriptTags(inlineLocalImages(inner || ''))
      return `<div class="slide-card">
  <span class="slide-no">${i + 1} / ${slides.length}</span>
  <div class="stage">${body}</div>
</div>`
    })
    .join('\n')

  const needsEcharts = slides.some(s => slideUsesEcharts(s))
  const needsChina = slides.some(s => needsChinaMap(s))
  const echartsScript = needsEcharts ? getInlineEchartsScript() : ''
  const chinaBootstrap = needsChina ? getChinaMapBootstrapScript() : ''
  const headScripts = [
    echartsScript ? `<script>${echartsScript}<\/script>` : '',
    chinaBootstrap ? `<script>${chinaBootstrap}<\/script>` : '',
  ].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    background:#1a1a1e;
    padding:28px 28px 60px;
    font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;
  }
  .hint{
    text-align:center;
    margin:0 0 24px;
    color:#555;
    font-size:11px;
    letter-spacing:.03em;
  }
  .deck{max-width:900px;margin:0 auto;}
  .slide-card{
    position:relative;width:100%;aspect-ratio:${spec.px} / ${spec.pxH};
    margin:0 auto 28px;border-radius:12px;overflow:hidden;
    box-shadow:0 2px 8px rgba(0,0,0,.4),0 12px 40px rgba(0,0,0,.5);
    background:#fff;container-type:inline-size;
  }
  .slide-no{
    position:absolute;top:10px;right:12px;z-index:9999;
    font-size:11px;color:rgba(255,255,255,.8);
    background:rgba(0,0,0,.4);padding:2px 8px;border-radius:10px;
    pointer-events:none;letter-spacing:.03em;
  }
  /* 固定画幅的舞台，等比缩放到卡片宽度；幻灯片内的 position:absolute 以此为基准 */
  .stage{
    position:absolute;left:0;top:0;
    width:${spec.px}px;height:${spec.pxH}px;
    overflow:hidden;background:#fff;color:#1f2937;
    font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",Arial,sans-serif;
    transform-origin:top left;
    transform:scale(calc(100cqw / ${spec.px}px));
  }
  .stage .bg{position:absolute;inset:0;}
${css || ''}
</style>
${headScripts}
</head>
<body>
<p class="hint">共 ${slides.length} 页 &middot; 向下滚动预览 &middot; 最终以 PowerPoint 打开为准</p>
<div class="deck">${cards}</div>
</body>
</html>`
}
