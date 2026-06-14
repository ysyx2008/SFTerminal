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
import { DECK_SIZES, type DeckSize } from './html-render-pptx'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PptPreview')

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
      const body = inlineLocalImages(inner || '')
      return `<div class="slide-card">
  <span class="slide-no">${i + 1} / ${slides.length}</span>
  <div class="stage">${body}</div>
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
    container-type:inline-size;
  }
  .slide-no{
    position:absolute;top:10px;right:14px;z-index:9999;
    font-size:12px;color:#fff;opacity:.65;
    background:rgba(0,0,0,.35);padding:2px 8px;border-radius:10px;
    pointer-events:none;
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
</head>
<body>
<p class="hint">共 ${slides.length} 页 · 向下滚动预览 · 最终以 PowerPoint 打开导出文件为准</p>
<div class="deck">${cards}</div>
</body>
</html>`
}
