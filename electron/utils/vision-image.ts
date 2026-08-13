/**
 * 视觉模型可接受的图片格式（与对话上传白名单一致）。
 * Word 内嵌 EMF/WMF、TIFF、SVG 等需先转成位图，否则豆包会报 Invalid base64 image_url。
 */

const VISION_COMPATIBLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
])

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/** 缩到 64×64 后的亮度标准差低于此值，视为空白底图。 */
const MIN_LUMA_STD = 12
const MIN_USABLE_SIDE = 48
const MAX_ASPECT_RATIO = 8
/** 有效位图面积不到最大内嵌图的 25%，视为矢量图上的图标碎片。 */
const MIN_CANVAS_COVERAGE = 0.25
const STAT_SIZE = 64

function normalizeVisionImageMime(contentType: string): string | null {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const normalized = MIME_ALIASES[mime] ?? mime
  return VISION_COMPATIBLE_MIMES.has(normalized) ? normalized : null
}

function slicePng(buf: Buffer, start: number): Buffer | null {
  if (start + 8 > buf.length) return null
  if (!buf.subarray(start, start + 8).equals(PNG_SIGNATURE)) return null
  let offset = start + 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const next = offset + 12 + length
    if (next > buf.length) return null
    if (type === 'IEND') return buf.subarray(start, next)
    offset = next
  }
  return null
}

function sliceJpeg(buf: Buffer, start: number): Buffer | null {
  if (start + 4 > buf.length) return null
  if (!buf.subarray(start, start + 3).equals(JPEG_SIGNATURE)) return null

  let i = start + 2
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null
    while (i < buf.length && buf[i] === 0xff) i++
    if (i >= buf.length) return null
    const marker = buf[i]
    i++
    if (marker === 0xd9) return buf.subarray(start, i)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (i + 2 > buf.length) return null
    const length = buf.readUInt16BE(i)
    if (length < 2 || i + length > buf.length) return null
    i += length
    if (marker !== 0xda) continue

    while (i + 1 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const next = buf[i + 1]
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        i += 2
        continue
      }
      if (next === 0xff) {
        i++
        continue
      }
      if (next === 0xd9) return buf.subarray(start, i + 2)
      return null
    }
    return null
  }
  return null
}

export type EmbeddedRaster = { mime: 'image/png' | 'image/jpeg'; bytes: Buffer }

type InspectedRaster = EmbeddedRaster & {
  width: number
  height: number
  area: number
  lumaStd: number
}

function lumaStdDev(pixels: Buffer): number {
  if (pixels.length === 0) return 0
  let sum = 0
  for (const value of pixels) sum += value
  const mean = sum / pixels.length
  let variance = 0
  for (const value of pixels) {
    const delta = value - mean
    variance += delta * delta
  }
  return Math.sqrt(variance / pixels.length)
}

function isUsableVisionRaster(raster: InspectedRaster): boolean {
  if (raster.lumaStd < MIN_LUMA_STD) return false
  if (raster.width < MIN_USABLE_SIDE || raster.height < MIN_USABLE_SIDE) return false
  const aspect = raster.width >= raster.height
    ? raster.width / raster.height
    : raster.height / raster.width
  return aspect <= MAX_ASPECT_RATIO
}

function isOfficeMetafile(contentType: string): boolean {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return mime.includes('emf') || mime.includes('wmf')
}

function toDataUrl(mime: string, buf: Buffer): string {
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** 抽出 EMF/WMF 里所有内嵌 PNG/JPEG，保持原格式。不识别 DIB/BMP 位图。 */
export function extractEmbeddedRasters(buf: Buffer): EmbeddedRaster[] {
  const found: EmbeddedRaster[] = []
  let offset = 0
  while (offset < buf.length) {
    const pngAt = buf.indexOf(PNG_SIGNATURE, offset)
    const jpegAt = buf.indexOf(JPEG_SIGNATURE, offset)
    const nextPng = pngAt >= 0 ? pngAt : Number.POSITIVE_INFINITY
    const nextJpeg = jpegAt >= 0 ? jpegAt : Number.POSITIVE_INFINITY
    const start = Math.min(nextPng, nextJpeg)
    if (!Number.isFinite(start)) break

    if (start === nextPng) {
      const png = slicePng(buf, start)
      if (png) {
        found.push({ mime: 'image/png', bytes: png })
        offset = start + png.length
        continue
      }
    } else {
      const jpeg = sliceJpeg(buf, start)
      if (jpeg) {
        found.push({ mime: 'image/jpeg', bytes: jpeg })
        offset = start + jpeg.length
        continue
      }
    }
    offset = start + 1
  }
  return found
}

export function extractEmbeddedRaster(buf: Buffer): EmbeddedRaster | null {
  return extractEmbeddedRasters(buf)[0] ?? null
}

/**
 * 把不支持的图片转成视觉模型能吃的 data URL。
 * 已是常见位图则原样规范化；否则尝试栅格化为 PNG。
 */
export class VisionImageConverter {
  private sharp: typeof import('sharp').default | null | undefined

  async convertToDataUrl(contentType: string, base64: string): Promise<string | null> {
    const raw = base64.replace(/\s+/g, '')
    if (!raw) return null
    const buf = Buffer.from(raw, 'base64')
    if (buf.length === 0) return null
    return this.convertBuffer(contentType, buf)
  }

  async convertBuffer(contentType: string, buf: Buffer): Promise<string | null> {
    const mime = normalizeVisionImageMime(contentType)
    if (mime) return toDataUrl(mime, buf)

    if (isOfficeMetafile(contentType)) {
      const embedded = await this.pickEmbeddedRaster(buf)
      if (embedded) return toDataUrl(embedded.mime, embedded.bytes)
      return null
    }

    const png = await this.trySharp(buf)
    if (png && png.length > 0) return toDataUrl('image/png', png)
    return null
  }

  /**
   * Office 矢量图：丢掉空白底图和小图标碎片；只有内嵌位图本身就是一张有内容的图才发出。
   * 无 sharp 时无法判断空图——多张内嵌则整张丢掉，仅一张则原样发出。
   */
  private async pickEmbeddedRaster(buf: Buffer): Promise<EmbeddedRaster | null> {
    const rasters = extractEmbeddedRasters(buf)
    if (rasters.length === 0) return null

    const sharp = await this.loadSharp()
    if (!sharp) return rasters.length === 1 ? rasters[0] : null

    const inspected = (await Promise.all(rasters.map((raster) => this.inspectRaster(sharp, raster))))
      .filter((item): item is InspectedRaster => item !== null)
    if (inspected.length === 0) return null

    const usable = inspected.filter(isUsableVisionRaster)
    if (usable.length === 0) return null

    usable.sort((a, b) => b.area - a.area)
    const best = usable[0]
    // 最大内嵌图当画布代理：有效图远小于它，说明是矢量图上的图标，不是整张图。
    const canvasArea = Math.max(...inspected.map((item) => item.area))
    if (best.area < canvasArea * MIN_CANVAS_COVERAGE) return null
    return { mime: best.mime, bytes: best.bytes }
  }

  private async inspectRaster(
    sharp: typeof import('sharp').default,
    raster: EmbeddedRaster
  ): Promise<InspectedRaster | null> {
    try {
      const image = sharp(raster.bytes, { limitInputPixels: 50_000_000 })
      const meta = await image.metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (width < 1 || height < 1) return null
      const { data } = await sharp(raster.bytes, { limitInputPixels: 50_000_000 })
        .rotate()
        .resize(STAT_SIZE, STAT_SIZE, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      return { ...raster, width, height, area: width * height, lumaStd: lumaStdDev(data) }
    } catch {
      return null
    }
  }

  private async trySharp(buf: Buffer): Promise<Buffer | null> {
    const sharp = await this.loadSharp()
    if (!sharp) return null
    try {
      return await sharp(buf).rotate().png().toBuffer()
    } catch {
      return null
    }
  }

  private async loadSharp(): Promise<typeof import('sharp').default | null> {
    if (this.sharp !== undefined) return this.sharp
    try {
      this.sharp = (await import('sharp')).default
    } catch {
      this.sharp = null
    }
    return this.sharp
  }
}

/**
 * 规范化即将发给视觉接口的图片 URL（同步，不转换）。
 * 转换应在抽图阶段完成；这里只挡住仍不合格的残留。
 */
export function toSendableVisionImageUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (!trimmed.startsWith('data:')) return null

  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(trimmed)
  if (!match) return null
  const mime = normalizeVisionImageMime(match[1])
  if (!mime) return null
  if (!match[2]) return null
  const b64 = match[3].replace(/\s+/g, '')
  if (!b64) return null
  return `data:${mime};base64,${b64}`
}
