import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  VisionImageConverter,
  extractEmbeddedRaster,
  extractEmbeddedRasters,
  toSendableVisionImageUrl,
} from '../vision-image'

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const PNG_BUF = Buffer.from(PNG_1X1, 'base64')

async function checkerboardPng(size = 64): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x >> 3) ^ (y >> 3)) & 1
      const i = (y * size + x) * 3
      const v = on ? 255 : 0
      raw[i] = v
      raw[i + 1] = v
      raw[i + 2] = v
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

async function flatJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 220, g: 225, b: 230 } },
  }).jpeg({ quality: 80 }).toBuffer()
}

describe('VisionImageConverter', () => {
  const converter = new VisionImageConverter()

  it('已是 png 则原样保留', async () => {
    const out = await converter.convertToDataUrl('image/png', PNG_1X1)
    expect(out).toBe(`data:image/png;base64,${PNG_1X1}`)
  })

  it('image/jpg 别名规范成 image/jpeg', async () => {
    const jpeg = await sharp(PNG_BUF).jpeg().toBuffer()
    const out = await converter.convertBuffer('image/jpg', jpeg)
    expect(out).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('tiff 转成 png', async () => {
    const tiff = await sharp(PNG_BUF).tiff().toBuffer()
    const out = await converter.convertBuffer('image/tiff', tiff)
    expect(out).toMatch(/^data:image\/png;base64,/)
  })

  it('svg 转成 png', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>'
    )
    const out = await converter.convertBuffer('image/svg+xml', svg)
    expect(out).toMatch(/^data:image\/png;base64,/)
  })

  it('EMF 包裹的有内容截图能抽出来', async () => {
    const png = await checkerboardPng(64)
    const emf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), png])
    const out = await converter.convertBuffer('image/x-emf', emf)
    expect(out).toMatch(/^data:image\/png;base64,/)
  })

  it('EMF 包裹的内嵌 jpeg 保持 jpeg，不转 png', async () => {
    const jpeg = await sharp(await checkerboardPng(64)).jpeg().toBuffer()
    const emf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), jpeg])
    const out = await converter.convertBuffer('image/x-emf', emf)
    expect(out).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('EMF 只有空白底图则丢掉', async () => {
    const plate = await flatJpeg(200, 120)
    const emf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), plate])
    const out = await converter.convertBuffer('image/x-emf', emf)
    expect(out).toBeNull()
  })

  it('EMF 空白底图加小图标碎片则整张丢掉', async () => {
    const plate = await flatJpeg(400, 300)
    const sprite = await sharp(await checkerboardPng(64)).jpeg().toBuffer()
    const emf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), plate, sprite])
    const out = await converter.convertBuffer('image/x-emf', emf)
    expect(out).toBeNull()
  })

  it('EMF 内嵌真正的大图时发出大图而不是小图标', async () => {
    const photo = await sharp(await checkerboardPng(160)).jpeg().toBuffer()
    const icon = await sharp(await checkerboardPng(48)).jpeg().toBuffer()
    const emf = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), photo, icon])
    const out = await converter.convertBuffer('image/x-emf', emf)
    expect(out).toMatch(/^data:image\/jpeg;base64,/)
    const b64 = out!.slice('data:image/jpeg;base64,'.length)
    const decoded = Buffer.from(b64, 'base64')
    const meta = await sharp(decoded).metadata()
    expect(meta.width).toBe(160)
    expect(meta.height).toBe(160)
  })

  it('无法识别的二进制返回 null', async () => {
    const out = await converter.convertBuffer('image/x-emf', Buffer.from([0x00, 0x01, 0x02, 0x03]))
    expect(out).toBeNull()
  })
})

describe('extractEmbeddedRaster', () => {
  it('从偏移处切开完整 png', () => {
    const wrapped = Buffer.concat([Buffer.from('xxxx'), PNG_BUF, Buffer.from('tail')])
    const extracted = extractEmbeddedRaster(wrapped)
    expect(extracted).not.toBeNull()
    expect(extracted!.mime).toBe('image/png')
    expect(extracted!.bytes.subarray(0, 8).equals(PNG_BUF.subarray(0, 8))).toBe(true)
  })

  it('能抽出多张内嵌位图', async () => {
    const a = await checkerboardPng(64)
    const b = await sharp(await checkerboardPng(48)).jpeg().toBuffer()
    const wrapped = Buffer.concat([Buffer.from('xx'), a, b])
    const all = extractEmbeddedRasters(wrapped)
    expect(all).toHaveLength(2)
    expect(all[0].mime).toBe('image/png')
    expect(all[1].mime).toBe('image/jpeg')
  })

  it('带 EXIF 缩略图的 jpeg 切出主图而不是缩略图', async () => {
    const main = await sharp(await checkerboardPng(64)).jpeg().toBuffer()
    const thumb = await sharp(await checkerboardPng(8)).jpeg().toBuffer()
    const app1 = Buffer.alloc(4 + thumb.length)
    app1[0] = 0xff
    app1[1] = 0xe1
    app1.writeUInt16BE(2 + thumb.length, 2)
    thumb.copy(app1, 4)
    const withThumb = Buffer.concat([main.subarray(0, 2), app1, main.subarray(2)])
    const extracted = extractEmbeddedRaster(Buffer.concat([Buffer.from('xx'), withThumb]))
    expect(extracted).not.toBeNull()
    expect(extracted!.bytes.length).toBe(withThumb.length)
    const meta = await sharp(extracted!.bytes).metadata()
    expect(meta.width).toBe(64)
    expect(meta.height).toBe(64)
  })
})

describe('toSendableVisionImageUrl', () => {
  it('放行 png data URL', () => {
    expect(toSendableVisionImageUrl(`data:image/png;base64,${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`
    )
  })

  it('丢掉 emf data URL', () => {
    expect(toSendableVisionImageUrl('data:image/x-emf;base64,AAAA')).toBeNull()
  })

  it('http(s) 远程图原样保留', () => {
    expect(toSendableVisionImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })
})
