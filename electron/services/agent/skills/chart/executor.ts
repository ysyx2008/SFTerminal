import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tools/types'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { buildOption, type ChartType, type ChartInput } from './render'
import { renderToSvg, type RenderSize } from './ssr'

const log = createLogger('ChartSkill')

const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 500
const MAX_DIM = 4000
const MIN_DIM = 100

const VALID_TYPES: readonly ChartType[] = [
  'bar', 'line', 'area', 'pie', 'scatter', 'radar', 'heatmap', 'candlestick'
]

function isChartType(v: unknown): v is ChartType {
  return typeof v === 'string' && (VALID_TYPES as readonly string[]).includes(v)
}

export async function executeChartTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'generate_chart':
      return generateChart(args, executor)
    default:
      return { success: false, output: '', error: t('chart.unknown_tool', { name: toolName }) }
  }
}

async function generateChart(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const type = args.type
  if (!isChartType(type)) {
    return { success: false, output: '', error: t('chart.invalid_type', { type: String(type) }) }
  }

  const size = clampSize(args.width, args.height)
  const input = argsToChartInput(args, type)

  const toolArgs: Record<string, unknown> = { type, width: size.width, height: size.height }
  if (input.title) toolArgs.title = input.title
  executor.addStep({
    type: 'tool_call',
    content: t('chart.generating', { type, title: input.title ?? '' }),
    toolName: 'generate_chart',
    toolArgs,
    riskLevel: 'safe'
  })

  let svgString: string
  try {
    const option = buildOption(input)
    svgString = await renderToSvg(option, size)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Failed to build/render chart:', msg)
    executor.addStep({
      type: 'tool_result',
      content: t('chart.render_failed'),
      toolName: 'generate_chart',
      toolResult: msg
    })
    return { success: false, output: '', error: t('chart.render_failed_detail', { error: msg }) }
  }

  const dataUrl = svgToDataUrl(svgString)

  let savedPath: string | undefined
  if (args.save_to_workspace === true) {
    try {
      savedPath = saveSvgToWorkspace(svgString, type)
    } catch (err) {
      log.warn('Failed to save chart to workspace:', err)
    }
  }

  const output = savedPath
    ? t('chart.generated_with_path', { type, path: savedPath })
    : t('chart.generated', { type })

  // 注意：images 只通过 ToolResult 返回，避免在 step 历史 + ToolResult 里重复存
  // 一份大体积的 base64 SVG（与 pdf skill 行为对齐）
  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'generate_chart',
    toolResult: output
  })

  return {
    success: true,
    output,
    images: [dataUrl]
  }
}

// ============================================================================
// helpers
// ============================================================================

function clampSize(w: unknown, h: unknown): RenderSize {
  const width = clampDim(w, DEFAULT_WIDTH)
  const height = clampDim(h, DEFAULT_HEIGHT)
  return { width, height }
}

function clampDim(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(v)))
}

function argsToChartInput(args: Record<string, unknown>, type: ChartType): ChartInput {
  return {
    type,
    title: typeof args.title === 'string' ? args.title : undefined,
    subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined,
    data: args.data,
    x_label: typeof args.x_label === 'string' ? args.x_label : undefined,
    y_label: typeof args.y_label === 'string' ? args.y_label : undefined,
    theme: args.theme === 'dark' ? 'dark' : 'light',
    kline_style: args.kline_style === 'us' ? 'us' : 'cn',
    legend: typeof args.legend === 'boolean' ? args.legend : undefined
  }
}

function svgToDataUrl(svg: string): string {
  const base64 = Buffer.from(svg, 'utf-8').toString('base64')
  return `data:image/svg+xml;base64,${base64}`
}

/**
 * 保存 SVG 到 agent-workspace/charts/{type}-{timestamp}.svg
 * 返回 workspace 相对路径（统一用 / 分隔，便于跨平台返给 AI 当 read_file 路径）
 */
function saveSvgToWorkspace(svg: string, type: ChartType): string {
  const workspace = path.join(app.getPath('userData'), 'agent-workspace')
  const dir = path.join(workspace, 'charts')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${type}-${Date.now()}.svg`
  const absPath = path.join(dir, filename)
  fs.writeFileSync(absPath, svg, 'utf-8')
  return `charts/${filename}`
}
