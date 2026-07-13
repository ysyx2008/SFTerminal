/**
 * PPT 技能执行器（html2pptx 路线）
 */

import * as fs from 'fs'
import * as path from 'path'
import type { CanvasData } from '@shared/types'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { getTerminalStateService } from '../../../terminal-state.service'
import { isAutoApproveWorkspacePath } from '../../tools/file'
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
  // deck 真相源：隐藏点文件，追加模式用。不污染用户目录、Finder 默认不显示。
  const deckJsonPath = path.join(
    path.dirname(pptxPath),
    '.' + path.basename(pptxPath).replace(/\.pptx$/i, '') + '.deck.json'
  )

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
  const inWorkspace = isAutoApproveWorkspacePath(pptxPath)
  // 覆盖非本技能维护的已有文件 → dangerous（对齐 write_text_file）；owned / 工作区 / 新建 → safe
  const isDangerousOverwrite = fileExists && !owned && !inWorkspace
  const riskLevel = isDangerousOverwrite ? 'dangerous' : 'safe'
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
    riskLevel,
  })

  // 覆盖确认：非本技能维护的工作区外已有文件（与 write_text_file 的 isDangerousOverwrite 一致）
  if (isDangerousOverwrite) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'ppt_from_html',
      { path: pptxPath },
      riskLevel,
      t('ppt.overwrite_confirm')
    )
    if (!approved) {
      return { success: false, output: '', error: t('ppt.user_rejected') }
    }
  }

  // 预览仅走 app 内 Canvas（内联 HTML），不落盘——它只是中间态，用户无需感知，
  // 且单独用浏览器打开时容器查询缩放在非 Chromium 引擎表现不一致。
  let previewDoc = ''
  try {
    previewDoc = buildPreviewDocument(deck.slides, deck.css, deck.size)
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
        })
      : t('ppt.created_from_html', {
          path: pptxPath,
          slides: result.slideCount,
        })

    let canvasData: CanvasData | undefined
    if (previewDoc) {
      canvasData = {
        action: 'open',
        renderer: 'html',
        title: path.basename(pptxPath),
        content: previewDoc,
        // Canvas 的"打开/在文件夹显示"指向真正的 .pptx 成品
        filePath: pptxPath,
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
