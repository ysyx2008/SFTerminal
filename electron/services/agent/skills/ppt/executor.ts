/**
 * PPT 技能执行器
 */

import * as fs from 'fs'
import * as path from 'path'
import type { CanvasData } from '@shared/types'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { getTerminalStateService } from '../../../terminal-state.service'
import { t } from '../../i18n'
import { buildPreviewDocument } from './html-parse'
import { convertHtmlToPptx } from './html-to-pptx'
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
  const htmlArg = args.html as string | undefined
  const htmlPathArg = args.html_path as string | undefined
  const theme = (args.theme as string | undefined)?.toLowerCase()
  const docTitle = args.title as string | undefined

  if (!pathArg) {
    return { success: false, output: '', error: t('ppt.path_required') }
  }
  if (htmlArg && htmlPathArg) {
    return { success: false, output: '', error: t('ppt.html_input_conflict') }
  }
  if (!htmlArg && !htmlPathArg) {
    return { success: false, output: '', error: t('ppt.html_input_required') }
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
    toolArgs: { path: pptxPath, theme },
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

  try {
    let html = htmlArg?.trim() || ''
    let mediaBaseDir = getTerminalStateService().getCwd(ptyId)

    if (htmlPathArg) {
      const htmlPath = resolvePath(ptyId, htmlPathArg)
      if (!fs.existsSync(htmlPath)) {
        return { success: false, output: '', error: t('error.file_not_found', { path: htmlPath }) }
      }
      html = fs.readFileSync(htmlPath, 'utf-8')
      mediaBaseDir = path.dirname(htmlPath)
      if (!html.trim()) {
        return { success: false, output: '', error: t('ppt.html_empty', { path: htmlPath }) }
      }
    }

    if (!html) {
      return { success: false, output: '', error: t('ppt.html_input_required') }
    }

    const deckHtmlPath = pptxPath.replace(/\.pptx$/i, '.html')
    fs.writeFileSync(deckHtmlPath, html, 'utf-8')

    const result = await convertHtmlToPptx({
      html,
      outputPath: pptxPath,
      theme,
      mediaBaseDir,
      title: docTitle,
    })

    const output = t('ppt.created_from_html', {
      path: pptxPath,
      htmlPath: deckHtmlPath,
      slides: result.slideCount,
      theme: theme || 'simple',
    })

    let canvasData: CanvasData | undefined
    try {
      canvasData = {
        action: 'open',
        renderer: 'html',
        title: path.basename(pptxPath),
        content: buildPreviewDocument(html),
        filePath: deckHtmlPath,
      }
    } catch (err) {
      log.warn('Canvas preview build failed:', err)
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
    const errorMsg = error instanceof Error ? error.message : t('ppt.convert_failed')
    log.error('ppt_from_html failed:', error)
    return { success: false, output: '', error: errorMsg }
  }
}
