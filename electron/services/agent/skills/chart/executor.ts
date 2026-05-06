import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tools/types'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { buildOption, type ChartType, type ChartInput, type EChartsOption } from './render'
import { renderToSvg, renderToPng, type RenderSize } from './ssr'

/** 输出格式：svg 矢量（默认）/ png 位图（嵌入 Word/PDF/IM 等） */
type ChartFormat = 'svg' | 'png'

function parseFormat(raw: unknown): ChartFormat {
  return raw === 'png' ? 'png' : 'svg'
}

const log = createLogger('ChartSkill')

// 兜底默认 1280×800（适合大多数中等复杂度图表，矢量+1.6x 于老 800×500，文件可控）
// 真正的尺寸决定权在 AI 手上——它最了解数据规模和图表类型，应在工具调用时显式传 width/height。
// 见 tools.ts 的 chartSkillContent 中的"按内容规模选画布尺寸"指引。
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MAX_DIM = 7680  // 8K 宽，足以画一年日 K（~250 根）或全天分钟级分时图（~240 点）
const MIN_DIM = 100

// PNG 像素密度（Retina 缩放）相关常量。
// - 默认 2：嵌入 Word/PDF/IM 时图片几乎都被缩放到 ~600px 显示，2× 像素能在缩放后保持锐利
// - 上限 4：4× 已经是打印级清晰度，再大对屏幕显示无意义且让文件变大、sharp 渲染压力上升
// - 像素维度上限 16384：sharp / libvips 在常规 64 位 Node 下处理 16K 像素已经接近舒适边界，
//   再大容易触发 "Input is too large" 类错误。本层兜底优先保护"不崩"，宁可降低 pixel_ratio
const DEFAULT_PNG_PIXEL_RATIO = 2
const MAX_PIXEL_RATIO = 4
const MAX_PIXEL_DIM = 16384

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
    case 'render_echarts_option':
      return renderEchartsOption(args, executor)
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
  const format = parseFormat(args.format)
  const pixelRatio = clampPixelRatio(args.pixel_ratio, format, size)

  // 步骤卡片只在 AI 显式传 format 时显示该字段，避免给"默认 svg"的旧调用平添噪音
  const toolArgs: Record<string, unknown> = { type, width: size.width, height: size.height }
  if (args.format !== undefined) toolArgs.format = format
  // pixel_ratio 仅 PNG 有意义；显式传或非默认值才进卡片，让用户/开发能看到实际生效的 DPI
  if (format === 'png' && (args.pixel_ratio !== undefined || pixelRatio !== DEFAULT_PNG_PIXEL_RATIO)) {
    toolArgs.pixel_ratio = pixelRatio
  }
  if (input.title) toolArgs.title = input.title
  executor.addStep({
    type: 'tool_call',
    content: t('chart.generating', { type, title: input.title ?? '' }),
    toolName: 'generate_chart',
    toolArgs,
    riskLevel: 'safe'
  })

  let rendered: { dataUrl: string; payload: string | Buffer }
  try {
    const option = buildOption(input, size)
    rendered = await renderChart(option, size, format, pixelRatio)
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

  let savedPath: string | undefined
  if (args.save_to_workspace === true) {
    try {
      savedPath = saveChartToWorkspace(rendered.payload, type, format)
    } catch (err) {
      log.warn('Failed to save chart to workspace:', err)
    }
  }

  const output = savedPath
    ? t('chart.generated_with_path', { type, path: savedPath })
    : t('chart.generated', { type })

  // chart skill 的图首要目标是「展示给用户」：
  //   - step.images 是前端 (AiPanel.vue / Awaken.vue / tool-display.ts) 渲染图片的唯一来源，
  //     必须带上，否则用户看不到生成的图。
  //   - ToolResult.images 故意不带：那条路径会经 flushPendingToolImages 注入到 AI
  //     的 user 消息当视觉输入，但主流多模态模型（OpenAI/Anthropic/Gemini）都不识别
  //     SVG 格式，发过去要么被拒、要么静默丢弃，还会让 AI 误以为「图我看过了」从而
  //     脑补内容。chart 工具的成功状态完全可由 success + output 判断，无需 AI 视觉校验。
  // PDF skill 反过来：图首要目标是给 AI 看（视觉分析扫描件），所以走 ToolResult.images。
  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'generate_chart',
    toolResult: output,
    images: [rendered.dataUrl]
  })

  return {
    success: true,
    output
  }
}

// ============================================================================
// render_echarts_option：自由路径，AI 直接传完整 ECharts option
// ============================================================================

async function renderEchartsOption(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 1) option 兜底：必填，且必须是 plain object（或可解析 JSON 字符串）
  let option: EChartsOption
  try {
    option = parseEchartsOption(args.option)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: '', error: msg }
  }

  const size = clampSize(args.width, args.height)
  const title = typeof args.title === 'string' ? args.title : ''
  const format = parseFormat(args.format)
  const pixelRatio = clampPixelRatio(args.pixel_ratio, format, size)

  // 2) 步骤卡片只展示 size + 可选 title，避免把整个 option（可能很大）塞进 toolArgs
  const toolArgs: Record<string, unknown> = { width: size.width, height: size.height, title }
  if (args.format !== undefined) toolArgs.format = format
  if (format === 'png' && (args.pixel_ratio !== undefined || pixelRatio !== DEFAULT_PNG_PIXEL_RATIO)) {
    toolArgs.pixel_ratio = pixelRatio
  }
  executor.addStep({
    type: 'tool_call',
    content: t('chart.echarts_rendering', { title }),
    toolName: 'render_echarts_option',
    toolArgs,
    riskLevel: 'safe'
  })

  let rendered: { dataUrl: string; payload: string | Buffer }
  try {
    rendered = await renderChart(option, size, format, pixelRatio)
  } catch (err) {
    // 关键设计：把 ECharts / sharp 的原始报错原样返给 AI，让它能定位到具体问题
    // （ECharts 报错通常带路径，如 "Invalid series.0.data"；sharp 报错通常是 SVG 解析问题）。
    const msg = err instanceof Error ? err.message : String(err)
    log.error('Failed to render custom echarts option:', msg)
    executor.addStep({
      type: 'tool_result',
      content: t('chart.render_failed'),
      toolName: 'render_echarts_option',
      toolResult: msg
    })
    return { success: false, output: '', error: t('chart.render_failed_detail', { error: msg }) }
  }

  let savedPath: string | undefined
  if (args.save_to_workspace === true) {
    try {
      // 自定义 echarts option 没有明确的 chart-type，统一保存为 'echarts' 前缀
      savedPath = saveChartToWorkspace(rendered.payload, 'echarts', format)
    } catch (err) {
      log.warn('Failed to save chart to workspace:', err)
    }
  }

  const output = savedPath
    ? t('chart.echarts_rendered_with_path', { path: savedPath })
    : t('chart.echarts_rendered')

  // 同 generate_chart：图走 step.images 给用户，不进 ToolResult.images（AI 看不到 SVG）
  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'render_echarts_option',
    toolResult: output,
    images: [rendered.dataUrl]
  })

  return { success: true, output }
}

/**
 * 把 args.option 解析成 ECharts option 对象。
 * 容错策略：
 *   - 已经是 plain object → 直接用
 *   - 是字符串 → JSON.parse（AI 偶尔会把 option 序列化成字符串传过来）
 *   - 其它都拒
 */
function parseEchartsOption(raw: unknown): EChartsOption {
  if (raw === undefined || raw === null) {
    throw new Error(t('chart.echarts_option_required'))
  }
  let candidate: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      throw new Error(t('chart.echarts_option_required'))
    }
    try {
      candidate = JSON.parse(trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(t('chart.echarts_option_invalid_json', { error: msg }))
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    const kind = candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate
    throw new Error(t('chart.echarts_option_not_object', { kind }))
  }
  return candidate as EChartsOption
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

/**
 * 把 pixel_ratio 参数归一化到 [1, MAX_PIXEL_RATIO]，并保证 size × ratio 不超过 MAX_PIXEL_DIM。
 *
 * - 非 PNG（svg）：永远返回 1，pixel_ratio 对矢量图无意义，强制忽略让上下游一致
 * - 缺省 / 异常输入（NaN / 负数 / 字符串）：用 DEFAULT_PNG_PIXEL_RATIO 兜底
 * - 上限：先按用户值 clamp 到 [1, 4]，再按 size 反推"不会爆 sharp"的安全上限取较小值。
 *   例如 width=7680 + ratio=4 = 30720 像素 → 触发维度兜底自动降回 ~2.13
 *
 * 浮点取两位小数，避免 step 卡片显示 "1.9999999999"
 */
function clampPixelRatio(raw: unknown, format: ChartFormat, size: RenderSize): number {
  if (format !== 'png') return 1
  const valid = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
  let ratio = valid ? raw : DEFAULT_PNG_PIXEL_RATIO
  ratio = Math.min(MAX_PIXEL_RATIO, Math.max(1, ratio))
  const maxDim = Math.max(size.width, size.height)
  if (maxDim * ratio > MAX_PIXEL_DIM) {
    // 像素维度超限时退到"刚好顶到 MAX_PIXEL_DIM"的比率；不会低于 1（width<=MAX_DIM 已保证）
    ratio = Math.max(1, MAX_PIXEL_DIM / maxDim)
  }
  return Math.round(ratio * 100) / 100
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
    kline_ma: parseKlineMa(args.kline_ma),
    legend: typeof args.legend === 'boolean' ? args.legend : undefined
  }
}

/**
 * 容错解析 kline_ma：仅接受数字数组（含空数组），其他形态（undefined/null/非数组）
 * 一律返回 undefined，让 render 走默认 [5,10,20,60]。
 * 数组里的元素也做正整数过滤。
 */
function parseKlineMa(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0)
}

/**
 * 按 format 渲染 ECharts option，返回前端要展示的 data URL + 可落盘的原始 payload
 * （SVG 是 utf-8 字符串，PNG 是 Buffer）。两个分支都走 step.images 展示给用户，
 * 不进 ToolResult.images（同样的"图给用户、不给 AI"原则——见 generate_chart 注释）。
 *
 * pixelRatio 仅 PNG 路径生效（SVG 是矢量、本身分辨率无关）；executor 已通过
 * clampPixelRatio 保证 PNG 时它落在合法区间。
 */
async function renderChart(
  option: EChartsOption,
  size: RenderSize,
  format: ChartFormat,
  pixelRatio: number
): Promise<{ dataUrl: string; payload: string | Buffer }> {
  if (format === 'png') {
    const buf = await renderToPng(option, size, { pixelRatio })
    return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, payload: buf }
  }
  const svg = await renderToSvg(option, size)
  return { dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`, payload: svg }
}

/**
 * 保存图表到 agent-workspace/charts/{prefix}-{timestamp}.{ext}
 * prefix 可以是 ChartType（generate_chart）或自定义前缀（render_echarts_option 用 'echarts'）
 * format=svg → 写 utf-8 文本；format=png → 写二进制 Buffer
 * 返回落盘绝对路径：对话里展示给用户时可点击打开；read_file 等工具同样可用该路径。
 */
function saveChartToWorkspace(
  payload: string | Buffer,
  prefix: ChartType | 'echarts',
  format: ChartFormat
): string {
  const workspace = path.join(app.getPath('userData'), 'agent-workspace')
  const dir = path.join(workspace, 'charts')
  fs.mkdirSync(dir, { recursive: true })
  const ext = format === 'png' ? 'png' : 'svg'
  const filename = `${prefix}-${Date.now()}.${ext}`
  const absPath = path.join(dir, filename)
  if (format === 'png') {
    fs.writeFileSync(absPath, payload as Buffer)
  } else {
    fs.writeFileSync(absPath, payload as string, 'utf-8')
  }
  return absPath
}
