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

interface DeckSource {
  title?: string
  size: DeckSize
  css: string
  slides: string[]
}

function resolvePath(ptyId: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath
  const cwd = getTerminalStateService().getCwd(ptyId)
  return path.resolve(cwd, filePath)
}

function readDeckSource(deckJsonPath: string): DeckSource | null {
  try {
    if (!fs.existsSync(deckJsonPath)) return null
    const raw = JSON.parse(fs.readFileSync(deckJsonPath, 'utf-8'))
    if (!raw || !Array.isArray(raw.slides)) return null
    return {
      title: typeof raw.title === 'string' ? raw.title : undefined,
      size: raw.size === 'standard' ? 'standard' : 'widescreen',
      css: typeof raw.css === 'string' ? raw.css : '',
      slides: raw.slides.map((s: unknown) => String(s)),
    }
  } catch (err) {
    log.warn('readDeckSource failed:', err)
    return null
  }
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
  const cssArg = (args.css as string | undefined) || ''
  const sizeArg = (args.size as string | undefined)?.toLowerCase()
  const reqSize: DeckSize = sizeArg === 'standard' ? 'standard' : 'widescreen'
  const docTitle = args.title as string | undefined
  const mode = (args.mode as string | undefined)?.toLowerCase() === 'append' ? 'append' : 'replace'

  if (!pathArg) {
    return { success: false, output: '', error: t('ppt.path_required') }
  }
  const newSlides = Array.isArray(slidesArg)
    ? (slidesArg as unknown[]).map((s) => String(s)).filter((s) => s.trim())
    : []
  if (newSlides.length === 0) {
    return { success: false, output: '', error: t('ppt.slides_required') }
  }

  let pptxPath = resolvePath(ptyId, pathArg)
  if (!pptxPath.toLowerCase().endsWith('.pptx')) {
    pptxPath += '.pptx'
  }
  const deckHtmlPath = pptxPath.replace(/\.pptx$/i, '.html')
  const deckJsonPath = pptxPath.replace(/\.pptx$/i, '.deck.json')

  // 合并 deck 真相源：append 在已有 deck 末尾追加
  const prev = mode === 'append' ? readDeckSource(deckJsonPath) : null
  const owned = !!prev // 有 deck.json 视为本技能拥有，追加无需覆盖确认
  const deck: DeckSource = {
    title: docTitle || prev?.title,
    size: prev?.size || reqSize,
    css: cssArg || prev?.css || '',
    slides: prev ? [...prev.slides, ...newSlides] : newSlides,
  }

  const fileExists = fs.existsSync(pptxPath)
  const appended = mode === 'append' && prev
  const tcKey = appended
    ? 'ppt.appending'
    : fileExists
      ? 'ppt.overwriting_from_html'
      : 'ppt.generating_from_html'

  const step = executor.addStep({
    type: 'tool_call',
    content: `${t(tcKey)}: ${pptxPath}`,
    toolName: 'ppt_from_html',
    toolArgs: { path: pptxPath, slides: deck.slides.length, mode, size: deck.size },
    riskLevel: fileExists && !owned ? 'moderate' : 'safe',
  })

  // 覆盖确认：仅当要覆盖一个非本技能维护的已有 .pptx（replace 或无 deck.json 的 append）
  if (fileExists && !owned) {
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

  // 预览 deck.html（整本，即使导出失败也保留供改）
  let previewDoc = ''
  try {
    previewDoc = buildPreviewDocument(deck.slides, deck.css, deck.size)
    fs.writeFileSync(deckHtmlPath, previewDoc, 'utf-8')
  } catch (err) {
    log.warn('Preview doc build failed:', err)
  }

  try {
    const result = await renderHtmlToPptx(
      {
        slides: deck.slides,
        css: deck.css,
        outputPath: pptxPath,
        title: deck.title,
        size: deck.size,
      },
      {
        isAborted: () => executor.isAborted(),
        onProgress: ({ done, total }) => {
          executor.updateStep(step.id, {
            content: `${t('ppt.rendering_progress', { done, total })}: ${pptxPath}`,
          })
        },
      }
    )

    // 渲染成功后再持久化 deck 真相源
    try {
      fs.writeFileSync(deckJsonPath, JSON.stringify(deck), 'utf-8')
    } catch (err) {
      log.warn('Persist deck source failed:', err)
    }

    const output = appended
      ? t('ppt.appended_from_html', {
          path: pptxPath,
          added: newSlides.length,
          slides: result.slideCount,
          htmlPath: deckHtmlPath,
        })
      : t('ppt.created_from_html', {
          path: pptxPath,
          slides: result.slideCount,
          htmlPath: deckHtmlPath,
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

    executor.updateStep(step.id, { content: output })
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
      const msg = t('ppt.validation_failed') + '\n' + error.issues.join('\n')
      return { success: false, output: '', error: msg }
    }
    const raw = error instanceof Error ? error.message : String(error)
    let errorMsg = raw
    if (raw.includes('NO_BROWSER')) errorMsg = t('ppt.no_browser')
    else if (raw.includes('NO_SLIDES')) errorMsg = t('ppt.slides_required')
    else if (raw.includes('ABORTED')) errorMsg = t('ppt.user_rejected')
    log.error('ppt_from_html failed:', error)
    return { success: false, output: '', error: errorMsg }
  }
}
