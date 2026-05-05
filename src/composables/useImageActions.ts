/**
 * 图片操作 composable：复制到剪贴板、另存为
 *
 * 设计要点：
 * - 输入是图片 URL（可以是 data URL 或 blob URL 或 http URL）
 * - 复制到剪贴板：统一转成 PNG，**优先走 Electron 原生 clipboard IPC**——
 *   浏览器 navigator.clipboard.write 在 Electron 里需要 document focus +
 *   Permissions Policy，Cmd+C 处理过程中焦点常已飘走，导致 "Write permission
 *   denied"。原生 clipboard 模块没有这层限制，最稳。Web 环境（无 electronAPI）
 *   降级到 navigator.clipboard。
 *   另：剪贴板格式统一用 PNG——这是 OS 剪贴板的最大公约数，SVG 几乎所有目标
 *   应用（聊天、文档、IDE）都不识别。
 * - 另存为：调 Electron 原生"保存为"对话框（IPC: image:saveWithDialog），
 *   用户在对话框的"格式"下拉里选 PNG / JPG / SVG，默认 PNG。
 *   * SVG 选项仅当源图就是 SVG 时出现（避免位图截图也提供 SVG 选项却存出位图嵌套）。
 *   * JPG 出图前会先填白底，避免透明背景被画成纯黑。
 *   Web 环境（无 electronAPI）降级到 <a download> 按原 mime 保存。
 */
import { useI18n } from 'vue-i18n'
import { toast } from './useToast'

export interface ImageActionContext {
  /** 用于生成默认文件名前缀，例如 'chart' / 'screenshot'；不传则用 'image' */
  defaultName?: string
}

/**
 * 把图片 URL 加载成 HTMLImageElement
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('failed to decode image'))
    img.src = url
  })
}

/**
 * SVG 源时按"长边目标"过采样导出位图——避免小逻辑画布存出来肉眼糊。
 * 位图源（截图/PNG）保持 1:1，没必要无谓放大变虚胖。
 *
 * @param longEdge 期望的长边像素数（PNG/JPG 另存推荐 3840 ≈ 4K，剪贴板推荐 1920~2560）
 * @returns scale 倍数（≥1）
 */
function pickScale(url: string, naturalW: number, naturalH: number, longEdge: number): number {
  const isSvg = url.startsWith('data:image/svg+xml')
  if (!isSvg) return 1
  const cur = Math.max(naturalW, naturalH)
  if (cur <= 0) return 1
  // 已经够大就不再放大（避免 AI 已画 4800 宽时还硬塞到 4K+），
  // 否则按长边目标算倍数；保底 1.5x 让矢量边缘锐化，封顶 4x 防呆
  if (cur >= longEdge) return 1
  const s = longEdge / cur
  return Math.max(1.5, Math.min(4, s))
}

/**
 * 把任意图片 URL 渲染到 canvas，再 toBlob 成指定格式
 *
 * 注意：SVG 转位图需要 SVG 内含明确的宽高（chart skill 设置过 width/height）。
 * 若 SVG 没声明尺寸，会用 fallbackSize 兜底。
 *
 * @param mime 'image/png' | 'image/jpeg' | ...
 * @param backgroundFill 可选背景色（如 JPEG 必须先填白底，否则透明像素会被画成纯黑）
 * @param targetLongEdge SVG 源时的目标长边像素，决定 supersample 倍数；位图源忽略
 */
async function imageUrlToBlob(
  url: string,
  mime = 'image/png',
  backgroundFill?: string,
  targetLongEdge = 1920,
  fallbackSize = 1024
): Promise<Blob> {
  const img = await loadImage(url)
  const baseW = img.naturalWidth || fallbackSize
  const baseH = img.naturalHeight || fallbackSize
  const scale = pickScale(url, baseW, baseH, targetLongEdge)
  const w = Math.round(baseW * scale)
  const h = Math.round(baseH * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  // 高质量缩放（默认 high 等价于 lanczos / bicubic，浏览器实现）
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (backgroundFill) {
    ctx.fillStyle = backgroundFill
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(img, 0, 0, w, h)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error(`canvas toBlob returned null for ${mime}`))
    }, mime, mime === 'image/jpeg' ? 0.95 : undefined)
  })
}

/**
 * 从 dataURL 推断 mime 与扩展名；未知时退化到 png
 */
function inferFormat(url: string): { mime: string; ext: string } {
  const m = url.match(/^data:([^;]+);/)
  if (m) {
    const mime = m[1]
    if (mime === 'image/svg+xml') return { mime, ext: 'svg' }
    if (mime === 'image/png') return { mime, ext: 'png' }
    if (mime === 'image/jpeg' || mime === 'image/jpg') return { mime, ext: 'jpg' }
    if (mime === 'image/gif') return { mime, ext: 'gif' }
    if (mime === 'image/webp') return { mime, ext: 'webp' }
  }
  return { mime: 'image/png', ext: 'png' }
}

/**
 * 把 data URL（含 base64）解码成 Blob，原样保留格式
 * 用于"另存为"——让 SVG 还是 SVG，PNG 还是 PNG
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',', 2)
  const mimeMatch = head.match(/^data:([^;]+)(;base64)?/)
  const mime = mimeMatch?.[1] ?? 'application/octet-stream'
  const isBase64 = head.includes(';base64')
  if (isBase64) {
    const bin = atob(body)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(body)], { type: mime })
}

export function useImageActions() {
  const { t } = useI18n()

  /**
   * 复制图片到剪贴板。无论原图是什么格式，统一写入 PNG（最高跨应用兼容性）。
   * 优先走 Electron 原生 clipboard IPC，失败/不可用时降级到 navigator.clipboard。
   */
  async function copyImage(url: string): Promise<void> {
    try {
      // 复制目标多为粘贴到聊天/文档/PPT，~2K 长边在多数场景已锐利且不会被服务端拒收
      const pngBlob = await imageUrlToBlob(url, 'image/png', undefined, 2560)

      const nativeWrite = window.electronAPI?.writeImageToClipboard
      if (typeof nativeWrite === 'function') {
        const buf = await pngBlob.arrayBuffer()
        await nativeWrite(buf)
        toast.success(t('ai.imageMenu.copySuccess'))
        return
      }

      // 浏览器环境降级
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error(t('ai.imageMenu.unsupported'))
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob })
      ])
      toast.success(t('ai.imageMenu.copySuccess'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('ai.imageMenu.copyFailed', { error: msg }))
      throw err
    }
  }

  /**
   * 另存为。优先弹原生"保存为"对话框，让用户选 PNG/JPG/SVG（默认 PNG）。
   * 当源图是 SVG 时多提供 SVG 选项以保留矢量；JPG 自动填白底。
   * Web 环境降级到 <a download>，按原 mime 保存。
   */
  async function saveImageAs(url: string, ctx?: ImageActionContext): Promise<void> {
    try {
      const prefix = ctx?.defaultName ?? 'image'
      const isSvgSource = url.startsWith('data:image/svg+xml')

      const nativeSave = window.electronAPI?.saveImageWithDialog
      if (typeof nativeSave === 'function') {
        // 另存为是"高清留档"场景——SVG 源按 4K 长边过采样，位图源 1:1
        // PNG 必备；JPG 总是提供（位图截图也常需要 jpg）；SVG 只在源是 SVG 时给
        const TARGET_LONG_EDGE = 3840
        const pngBlob = await imageUrlToBlob(url, 'image/png', undefined, TARGET_LONG_EDGE)
        const jpgBlob = await imageUrlToBlob(url, 'image/jpeg', '#ffffff', TARGET_LONG_EDGE)
        const buffers: Record<string, ArrayBuffer | string> = {
          png: await pngBlob.arrayBuffer(),
          jpg: await jpgBlob.arrayBuffer()
        }
        const filters: Array<{ label: string; extensions: string[] }> = [
          { label: t('ai.imageMenu.filterPng'), extensions: ['png'] },
          { label: t('ai.imageMenu.filterJpg'), extensions: ['jpg', 'jpeg'] }
        ]
        if (isSvgSource) {
          buffers.svg = await dataUrlToBlob(url).text()
          filters.push({ label: t('ai.imageMenu.filterSvg'), extensions: ['svg'] })
        }

        const res = await nativeSave({
          defaultName: `${prefix}-${Date.now()}`,
          filters,
          buffers
        })
        if (!res.saved) return // 用户取消，静默
        toast.success(t('ai.imageMenu.saveSuccess', { filename: res.filename ?? '' }))
        return
      }

      // 浏览器/无 IPC 环境降级：<a download> 按原格式保存
      const { ext } = inferFormat(url)
      const filename = `${prefix}-${Date.now()}.${ext}`
      let href = url
      if (url.startsWith('data:')) {
        const blob = dataUrlToBlob(url)
        href = URL.createObjectURL(blob)
      }
      const a = document.createElement('a')
      a.href = href
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      if (href !== url) setTimeout(() => URL.revokeObjectURL(href), 1000)
      toast.success(t('ai.imageMenu.saveSuccess', { filename }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('ai.imageMenu.saveFailed', { error: msg }))
      throw err
    }
  }

  return { copyImage, saveImageAs }
}
