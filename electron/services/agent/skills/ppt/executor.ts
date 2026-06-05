/**
 * PPT 技能执行器（html2pptx 路线）
 */

import * as fs from 'fs'
import * as path from 'path'
import type { CanvasData } from '@shared/types'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { getTerminalStateService } from '../../../terminal-state.service'
import { t } from '../../i18n'
import { buildPreviewDocument } from './preview'
import { renderHtmlToPptx, PptValidationError, type DeckSize } from './html-render-pptx'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PptSkill')

function resolvePath(ptyId: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath
  const cwd = getTerminalStateService().getCwd(ptyId)
  return path.resolve(cwd, filePath)
}

export async function executePptTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'ppt_from_html':
      return pptFromHtml(ptyId, args, toolCallId, config, executor)
    default:
      return { success: false, output: '', error: t('ppt.unknown_tool', { name: toolName }) }
  }
}

async function pptFromHtml(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const pathArg = args.path as string
  const slidesArg = args.slides as unknown
  const css = (args.css as string | undefined) || ''
  const sizeArg = (args.size as string | undefined)?.toLowerCase()
  const size: DeckSize = sizeArg === 'standard' ? 'standard' : 'widescreen'
  const docTitle = args.title as string | undefined

  if (!pathArg) {
    return { success: false, output: '', error: t('ppt.path_required') }
  }
  const slides = Array.isArray(slidesArg)
    ? (slidesArg as unknown[]).map((s) => String(s)).filter((s) => s.trim())
    : []
  if (slides.length === 0) {
    return { success: false, output: '', error: t('ppt.slides_required') }
  }

  let pptxPath = resolvePath(ptyId, pathArg)
  if (!pptxPath.toLowerCase().endsWith('.pptx')) {
    pptxPath += '.pptx'
  }

  const fileExists = fs.existsSync(pptxPath)
  const tcKey = fileExists ? 'ppt.overwriting_from_html' : 'ppt.generating_from_html'

  executor.addStep({
    type: 'tool_call',
    content: `${t(tcKey)}: ${pptxPath}`,
    toolName: 'ppt_from_html',
    toolArgs: { path: pptxPath, slides: slides.length, size },
    riskLevel: fileExists ? 'moderate' : 'safe',
  })

  if (fileExists) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'ppt_from_html',
      { path: pptxPath },
      'moderate',
      t('ppt.overwrite_confirm')
    )
    if (!approved) {
      return { success: false, output: '', error: t('ppt.user_rejected') }
    }
  }

  // 先把预览 deck.html 写盘（即使导出失败也能让用户/AI 看 HTML 改）
  const deckHtmlPath = pptxPath.replace(/\.pptx$/i, '.html')
  let previewDoc = ''
  try {
    previewDoc = buildPreviewDocument(slides, css, size)
    fs.writeFileSync(deckHtmlPath, previewDoc, 'utf-8')
  } catch (err) {
    log.warn('Preview doc build failed:', err)
  }

  try {
    const result = await renderHtmlToPptx({
      slides,
      css,
      outputPath: pptxPath,
      title: docTitle,
      size,
    })

    const output = t('ppt.created_from_html', {
      path: pptxPath,
      htmlPath: deckHtmlPath,
      slides: result.slideCount,
    })

    let canvasData: CanvasData | undefined
    if (previewDoc) {
      canvasData = {
        action: 'open',
        renderer: 'html',
        title: path.basename(pptxPath),
        content: previewDoc,
        filePath: deckHtmlPath,
      }
    }

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'ppt_from_html',
      toolResult: output,
      canvasData,
    })

    return { success: true, output }
  } catch (error) {
    if (error instanceof PptValidationError) {
      // 校验失败：把每页问题清单回传，引导 AI 改 HTML 重试
      const msg = t('ppt.validation_failed') + '\n' + error.issues.join('\n')
      return { success: false, output: '', error: msg }
    }
    const raw = error instanceof Error ? error.message : String(error)
    let errorMsg = raw
    if (raw.includes('NO_BROWSER')) errorMsg = t('ppt.no_browser')
    else if (raw.includes('NO_SLIDES')) errorMsg = t('ppt.slides_required')
    log.error('ppt_from_html failed:', error)
    return { success: false, output: '', error: errorMsg }
  }
}
