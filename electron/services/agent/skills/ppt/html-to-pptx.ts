/**
 * 约束版 Slide HTML → PPTX（PptxGenJS）
 */

import * as fs from 'fs'
import * as path from 'path'
import { parseSlidesFromHtml } from './html-parse'
import { renderSlideLayout } from './layouts'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('HtmlToPptx')

export interface ConvertHtmlToPptxOptions {
  html: string
  outputPath: string
  theme?: string
  mediaBaseDir: string
  title?: string
}

export interface ConvertHtmlToPptxResult {
  outputPath: string
  slideCount: number
}

export async function convertHtmlToPptx(
  options: ConvertHtmlToPptxOptions
): Promise<ConvertHtmlToPptxResult> {
  const slides = parseSlidesFromHtml(options.html)
  const pptxModule = await import('pptxgenjs')
  const PptxGenJS = pptxModule.default
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_16x9'
  pres.author = 'SailFish'
  pres.title = options.title || path.basename(options.outputPath, '.pptx')

  for (const parsed of slides) {
    const slide = pres.addSlide()
    renderSlideLayout({
      pptx: pres,
      slide,
      parsed,
      globalThemeId: options.theme,
      mediaBaseDir: options.mediaBaseDir,
    })
  }

  const dir = path.dirname(options.outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  await pres.writeFile({ fileName: options.outputPath })
  log.info(`Wrote ${slides.length} slides to ${options.outputPath}`)

  return {
    outputPath: options.outputPath,
    slideCount: slides.length,
  }
}
