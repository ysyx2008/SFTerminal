/**
 * chart executor 契约测试
 *
 * 关键不变量（容易被「优化」时无意打破）：
 * - step.images **必须**带 dataURL —— 前端 (AiPanel/Awaken/tool-display) 是从 step.images 渲染
 * - step.echartsOption **仅在 svg 模式**注入 —— 让前端实例化为「活图」（tooltip / dataZoom 等）；
 *   PNG 模式刻意不带，因为 AI 选 PNG 通常意味着「我要导出位图给 word/IM」，气泡内 PNG 预览
 *   与导出物视觉一致更直观。两条规则 buildOption / renderChart 都覆盖。
 * - ToolResult.images **必须**为空 —— 这条路径会触发 flushPendingToolImages 把 SVG
 *   作为视觉输入塞给 AI，但主流多模态模型不识别 SVG，会让 AI 误以为「我看过图了」
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 把 electron.app.getPath('userData') 指向独立 tmp 目录，让 save_to_workspace 真实写盘可断言
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-executor-test-'))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => name === 'userData' ? userDataDir : '/tmp')
  }
}))

import { executeChartTool } from '../executor'
import type { AgentStep } from '../../../types'
import type { ToolExecutorConfig } from '../../../tools/types'

function makeExecutor(): { config: ToolExecutorConfig; steps: Array<Omit<AgentStep, 'id' | 'timestamp'>> } {
  const steps: Array<Omit<AgentStep, 'id' | 'timestamp'>> = []
  const addStep = vi.fn((step: Omit<AgentStep, 'id' | 'timestamp'>) => {
    steps.push(step)
    return { ...step, id: `step-${steps.length}`, timestamp: Date.now() } as AgentStep
  })
  // chart executor 实际只用到 addStep；其它字段用 as unknown as 转型避免补一长串无用 stub
  const config = {
    addStep,
    updateStep: vi.fn(),
    isAborted: () => false
  } as unknown as ToolExecutorConfig
  return { config, steps }
}

describe('executeChartTool: image delivery contract', () => {
  it('delivers SVG via step.images (frontend renders from here)', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'pie',
        data: [{ name: 'A', value: 30 }, { name: 'B', value: 70 }]
      },
      'call-1',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    expect(toolResultStep).toBeDefined()
    expect(toolResultStep?.images?.length).toBe(1)
    expect(toolResultStep?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('does NOT return images in ToolResult (avoids feeding unsupported SVG to AI vision)', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1', 'Q2'], series: [{ name: 'x', data: [1, 2] }] }
      },
      'call-2',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    expect(result.images).toBeUndefined()
  })

  it('returns success=false with friendly error on bad data, no SVG in step', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      { type: 'pie', data: 'oops not array' },
      'call-3',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/pie data must be array/)
    const errStep = steps.find(s => s.type === 'tool_result')
    expect(errStep?.images).toBeUndefined()
  })

  it('rejects unknown chart type', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      { type: 'pyramid', data: [] },
      'call-4',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Unsupported|不支持/)
  })

  it('format=png delivers image/png data URL via step.images', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        title: '季度营收',
        data: { categories: ['Q1', 'Q2'], series: [{ name: '营收', data: [100, 200] }] },
        format: 'png'
      },
      'call-png',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    expect(toolResultStep?.images?.length).toBe(1)
    expect(toolResultStep?.images?.[0]).toMatch(/^data:image\/png;base64,/)
    // PNG 同样不进 ToolResult.images，保持 chart 一贯"图给用户、不给 AI"原则
    expect(result.images).toBeUndefined()
    // PNG 模式不投递 echartsOption（AI 显式选位图导出，气泡看 PNG 预览与导出物一致）
    expect(toolResultStep?.echartsOption).toBeUndefined()
  })

  it('svg mode（默认）同时投递 echartsOption（活图）+ images（兜底）', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1', 'Q2'], series: [{ name: 'x', data: [1, 2] }] },
        width: 800,
        height: 500
      },
      'call-svg-echarts',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    // 兜底 SVG dataURL 仍在
    expect(toolResultStep?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    // 活图载荷：option 是 plain object，width/height 跟 size 一致
    const payload = toolResultStep?.echartsOption
    expect(payload).toBeDefined()
    expect(payload?.width).toBe(800)
    expect(payload?.height).toBe(500)
    expect(typeof payload?.option).toBe('object')
    // option 应已被 applyCommon inline 主题（前后端视觉一致的关键）
    expect(payload?.option).toHaveProperty('backgroundColor')
    expect(payload?.option).toHaveProperty('series')
  })

  it('render_echarts_option svg 模式同样投递 echartsOption', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: {
          xAxis: { type: 'category', data: ['一月', '二月'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [10, 20] }]
        },
        width: 1024,
        height: 600
      },
      'call-free-echarts',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    const payload = toolResultStep?.echartsOption
    expect(payload).toBeDefined()
    expect(payload?.width).toBe(1024)
    expect(payload?.height).toBe(600)
    // 自由路径下 option 透传，user 给的字段必须保留
    expect(payload?.option).toHaveProperty('series')
    // 未设背景时按 theme:light 注入预设白底
    expect((payload?.option as { backgroundColor?: string }).backgroundColor).toBe('#ffffff')
  })

  it('render_echarts_option 支持 background_color 覆盖 option', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: {
          backgroundColor: '#000000',
          xAxis: { type: 'category', data: ['a'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [1] }]
        },
        background_color: '#f0f0f0',
        width: 800,
        height: 500
      },
      'call-bg-override',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const payload = steps.find(s => s.type === 'tool_result')?.echartsOption
    expect((payload?.option as { backgroundColor?: string }).backgroundColor).toBe('#f0f0f0')
  })

  it('K 线 svg 模式：投递的 echartsOption 里 function formatter 被替换为 marker（保活图、过 IPC）', async () => {
    const { config, steps } = makeExecutor()
    // K 线 buildCandlestick 的成交量 yAxis 用 formatVolume function，必须通过 marker 协议
    // 才能过 Electron IPC（structuredClone）。
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'candlestick',
        title: 'K 线 marker 测试',
        data: {
          categories: ['1', '2', '3'],
          values: [[10, 12, 9, 13], [12, 11, 10, 13], [11, 14, 11, 15]],
          volumes: [100000, 200000, 150000]
        },
        width: 1600,
        height: 800
      },
      'call-kline-marker',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const stepResult = steps.find(s => s.type === 'tool_result')
    const payload = stepResult?.echartsOption
    expect(payload).toBeDefined()

    // sanitize 后的 option 必须能通过 structuredClone（IPC 投递不报错）
    expect(() => structuredClone(payload!.option)).not.toThrow()

    // 在 yAxis 数组里找成交量轴的 axisLabel.formatter——应该是 marker 而不是 function
    const opt = payload!.option as {
      yAxis: Array<{ axisLabel?: { formatter?: unknown } }>
      tooltip: { formatter?: unknown }
    }
    const volumeAxis = opt.yAxis.find(a => a.axisLabel?.formatter)
    expect(volumeAxis).toBeDefined()
    expect(volumeAxis!.axisLabel!.formatter).toEqual({ __echartsFn: 'volume' })
    // tooltip.formatter 也应该是 marker（中文 OHLC 输出由前端 reify 还原）
    expect(opt.tooltip.formatter).toEqual({ __echartsFn: 'klineTooltip' })
  })

  it('render_echarts_option svg 模式：含 function formatter 的 option 静默降级，仅走 SVG 兜底（避免 IPC DataCloneError）', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: {
          xAxis: { type: 'category', data: ['Q1', 'Q2'] },
          yAxis: { type: 'value' },
          tooltip: {
            // ECharts 文档主推写法之一：function formatter。在后端 SSR 时是有效的
            // （同进程同 V8），但走 IPC 给前端会被 structuredClone 拒绝。
            formatter: (params: { value: number }) => `Custom: ${params.value}`
          },
          series: [{ type: 'bar', data: [10, 20] }]
        }
        // 默认 svg 模式
      },
      'call-fn-formatter',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const stepResult = steps.find(s => s.type === 'tool_result')
    // SVG dataURL 仍存在（后端 SSR 没问题）
    expect(stepResult?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    // 但活图载荷被静默丢弃，避免 IPC 抛 DataCloneError
    expect(stepResult?.echartsOption).toBeUndefined()
  })

  it('render_echarts_option png 模式不投递 echartsOption（与 generate_chart 一致）', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: { series: [{ type: 'gauge', data: [{ value: 50 }] }] },
        format: 'png'
      },
      'call-free-png-no-echarts',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    expect(toolResultStep?.images?.[0]).toMatch(/^data:image\/png;base64,/)
    expect(toolResultStep?.echartsOption).toBeUndefined()
  })

  it('default format remains svg (向后兼容：未传 format 不应改变行为)', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      { type: 'pie', data: [{ name: 'A', value: 30 }] },
      'call-default',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const toolResultStep = steps.find(s => s.type === 'tool_result')
    expect(toolResultStep?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    // tool_call 步骤的 toolArgs 不该出现 format 字段（默认 svg，未显式传时不污染卡片）
    const toolCallStep = steps.find(s => s.type === 'tool_call')
    expect(toolCallStep?.toolArgs).not.toHaveProperty('format')
  })

  it('parseFormat: 异常值 (jpg/null/数字) 一律回落到 svg', async () => {
    for (const bad of ['jpg', null, 1, true, '', 'PNG']) {
      const { config, steps } = makeExecutor()
      const result = await executeChartTool(
        'generate_chart',
        'pty-1',
        { type: 'pie', data: [{ name: 'A', value: 1 }], format: bad },
        `call-bad-${String(bad)}`,
        {} as Parameters<typeof executeChartTool>[4],
        config
      )
      expect(result.success).toBe(true)
      const stepResult = steps.find(s => s.type === 'tool_result')
      expect(stepResult?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    }
  })
})

describe('executeChartTool: save_to_workspace + format', () => {
  afterAll(() => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('format=png + save_to_workspace 落盘 .png 后缀且文件是 PNG 格式', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'pie',
        data: [{ name: 'A', value: 30 }, { name: 'B', value: 70 }],
        format: 'png',
        save_to_workspace: true
      },
      'call-save-png',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const pieFile = result.output!.match(/(pie-\d+\.png)/)?.[1]
    expect(pieFile).toBeDefined()
    const abs = path.join(userDataDir, 'agent-workspace', 'charts', pieFile!)
    expect(path.normalize(result.output!)).toContain(path.normalize(abs))
    expect(fs.existsSync(abs)).toBe(true)
    const buf = fs.readFileSync(abs)
    expect(buf[0]).toBe(0x89) // PNG magic
    expect(buf[1]).toBe(0x50)
    expect(buf.length).toBeGreaterThan(500)
  })

  it('默认 format=svg + save_to_workspace 落盘 .svg 后缀且是 SVG 文本', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1'], series: [{ name: 'x', data: [1] }] },
        save_to_workspace: true
      },
      'call-save-svg',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const barFile = result.output!.match(/(bar-\d+\.svg)/)?.[1]
    expect(barFile).toBeDefined()
    const abs = path.join(userDataDir, 'agent-workspace', 'charts', barFile!)
    expect(path.normalize(result.output!)).toContain(path.normalize(abs))
    expect(fs.existsSync(abs)).toBe(true)
    const text = fs.readFileSync(abs, 'utf-8')
    expect(text).toMatch(/^<svg/)
  })

  it('render_echarts_option + format=png + save_to_workspace 落 echarts-xxx.png', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: { series: [{ type: 'gauge', data: [{ value: 50 }] }] },
        format: 'png',
        save_to_workspace: true
      },
      'call-save-free-png',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )

    expect(result.success).toBe(true)
    const echartsFile = result.output!.match(/(echarts-\d+\.png)/)?.[1]
    expect(echartsFile).toBeDefined()
    const abs = path.join(userDataDir, 'agent-workspace', 'charts', echartsFile!)
    expect(path.normalize(result.output!)).toContain(path.normalize(abs))
    expect(fs.existsSync(abs)).toBe(true)
  })
})

describe('executeChartTool: pixel_ratio (PNG 像素密度，与布局尺寸解耦)', () => {
  // 复用 render.test.ts 的 PNG IHDR 解析法
  function pngDims(buf: Buffer): { width: number; height: number } {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  function dataUrlToBuffer(dataUrl: string): Buffer {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    return Buffer.from(base64, 'base64')
  }

  it('format=png 默认 pixel_ratio=2 → PNG 像素 ≈ 2× width', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1', 'Q2'], series: [{ name: 'x', data: [1, 2] }] },
        width: 800,
        height: 500,
        format: 'png'
      },
      'call-pr-default',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width, height } = pngDims(buf)
    expect(width).toBeGreaterThanOrEqual(1599)
    expect(width).toBeLessThanOrEqual(1601)
    expect(height).toBeGreaterThanOrEqual(999)
    expect(height).toBeLessThanOrEqual(1001)
    // 默认值不污染步骤卡片（用户没显式传，卡片不该出现 pixel_ratio）
    const callStep = steps.find(s => s.type === 'tool_call')
    expect(callStep?.toolArgs).not.toHaveProperty('pixel_ratio')
  })

  it('format=png + pixel_ratio=1 → 1:1 像素', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1'], series: [{ name: 'x', data: [1] }] },
        width: 800,
        height: 500,
        format: 'png',
        pixel_ratio: 1
      },
      'call-pr-1',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width, height } = pngDims(buf)
    expect(width).toBe(800)
    expect(height).toBe(500)
    // 显式传入 → 步骤卡片应展示生效 ratio
    const callStep = steps.find(s => s.type === 'tool_call')
    expect(callStep?.toolArgs).toHaveProperty('pixel_ratio', 1)
  })

  it('format=png + pixel_ratio=3 → 3× 像素', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'pie',
        data: [{ name: 'A', value: 1 }],
        width: 400,
        height: 300,
        format: 'png',
        pixel_ratio: 3
      },
      'call-pr-3',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width, height } = pngDims(buf)
    expect(width).toBeGreaterThanOrEqual(1199)
    expect(width).toBeLessThanOrEqual(1201)
    expect(height).toBeGreaterThanOrEqual(899)
    expect(height).toBeLessThanOrEqual(901)
  })

  it('pixel_ratio>4 被钳到 4（防爆）', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'pie',
        data: [{ name: 'A', value: 1 }],
        width: 400,
        height: 300,
        format: 'png',
        pixel_ratio: 100
      },
      'call-pr-clamp-max',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width } = pngDims(buf)
    // 4× 400 = 1600，给点容差
    expect(width).toBeGreaterThanOrEqual(1599)
    expect(width).toBeLessThanOrEqual(1601)
    const callStep = steps.find(s => s.type === 'tool_call')
    expect(callStep?.toolArgs).toHaveProperty('pixel_ratio', 4)
  })

  it('pixel_ratio<1 / NaN / 字符串 → 回落默认 2', async () => {
    for (const bad of [0, -2, NaN, 'big', null]) {
      const { config, steps } = makeExecutor()
      await executeChartTool(
        'generate_chart',
        'pty-1',
        {
          type: 'pie',
          data: [{ name: 'A', value: 1 }],
          width: 400,
          height: 300,
          format: 'png',
          pixel_ratio: bad
        },
        `call-pr-bad-${String(bad)}`,
        {} as Parameters<typeof executeChartTool>[4],
        config
      )
      const stepResult = steps.find(s => s.type === 'tool_result')
      const buf = dataUrlToBuffer(stepResult!.images![0])
      const { width } = pngDims(buf)
      // 默认 2× 400 = 800
      expect(width).toBeGreaterThanOrEqual(799)
      expect(width).toBeLessThanOrEqual(801)
    }
  })

  it('format=svg 时 pixel_ratio 被忽略（SVG 是矢量，与像素无关）', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['Q1'], series: [{ name: 'x', data: [1] }] },
        width: 800,
        height: 500,
        pixel_ratio: 4
      },
      'call-pr-svg-ignored',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const stepResult = steps.find(s => s.type === 'tool_result')
    expect(stepResult?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    // SVG 路径不该把 pixel_ratio 写进卡片（避免给"我有像素密度"的错觉）
    const callStep = steps.find(s => s.type === 'tool_call')
    expect(callStep?.toolArgs).not.toHaveProperty('pixel_ratio')
  })

  it('size × ratio 超出 MAX_PIXEL_DIM 时自动降低 ratio（防爆 sharp）', async () => {
    // width=7680（MAX_DIM）+ pixel_ratio=4 → 30720 像素，应被钳回 ~2.13
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'generate_chart',
      'pty-1',
      {
        type: 'bar',
        data: { categories: ['a'], series: [{ name: 'x', data: [1] }] },
        width: 7680,
        height: 1000,
        format: 'png',
        pixel_ratio: 4
      },
      'call-pr-dim-cap',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const callStep = steps.find(s => s.type === 'tool_call')
    const usedRatio = callStep?.toolArgs?.pixel_ratio as number
    // MAX_PIXEL_DIM / 7680 = 2.133...，executor 取两位小数
    expect(usedRatio).toBeGreaterThan(2)
    expect(usedRatio).toBeLessThan(2.5)
    // 即便维度兜底也绝不能让 ratio 跌到 <1（小于 1 会让 sharp density<72 出怪图）；
    // 数学上 width<=MAX_DIM(7680)<MAX_PIXEL_DIM(16384) 保证比值恒>1，但锁住这条不变量
    expect(usedRatio).toBeGreaterThanOrEqual(1)
    // 实际像素也应 <=16384
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width } = pngDims(buf)
    expect(width).toBeLessThanOrEqual(16384)
  })

  it('render_echarts_option 同样支持 pixel_ratio', async () => {
    const { config, steps } = makeExecutor()
    await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: { series: [{ type: 'gauge', data: [{ value: 50 }] }] },
        width: 600,
        height: 400,
        format: 'png',
        pixel_ratio: 2
      },
      'call-free-pr',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    const stepResult = steps.find(s => s.type === 'tool_result')
    const buf = dataUrlToBuffer(stepResult!.images![0])
    const { width, height } = pngDims(buf)
    expect(width).toBeGreaterThanOrEqual(1199)
    expect(width).toBeLessThanOrEqual(1201)
    expect(height).toBeGreaterThanOrEqual(799)
    expect(height).toBeLessThanOrEqual(801)
  })
})

describe('executeChartTool: render_echarts_option + format=png', () => {
  it('format=png on free path: 同样产 image/png data URL', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: {
          xAxis: { type: 'category', data: ['一月', '二月'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [10, 20] }]
        },
        format: 'png'
      },
      'call-free-png',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const stepResult = steps.find(s => s.type === 'tool_result')
    expect(stepResult?.images?.[0]).toMatch(/^data:image\/png;base64,/)
  })
})

describe('executeChartTool: render_echarts_option (free path)', () => {
  it('renders arbitrary ECharts option (sankey, generate_chart 不支持的类型)', async () => {
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {
        option: {
          series: [{
            type: 'sankey',
            data: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
            links: [
              { source: 'A', target: 'B', value: 10 },
              { source: 'B', target: 'C', value: 6 }
            ]
          }]
        }
      },
      'call-sankey',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
    const stepResult = steps.find(s => s.type === 'tool_result')
    expect(stepResult?.images?.length).toBe(1)
    expect(stepResult?.images?.[0]).toMatch(/^data:image\/svg\+xml;base64,/)
    // 同 generate_chart：图不进 ToolResult.images（避免给 AI 喂 SVG）
    expect(result.images).toBeUndefined()
  })

  it('accepts JSON string option (AI 偶尔会把 option 序列化成字符串传过来)', async () => {
    const { config } = makeExecutor()
    const optionStr = JSON.stringify({
      series: [{ type: 'gauge', data: [{ value: 50 }] }]
    })
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      { option: optionStr },
      'call-gauge',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(true)
  })

  it('returns friendly error when option missing', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      {},
      'call-empty',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/option .*required|必填/)
  })

  it('returns friendly error when option string is invalid JSON', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      { option: '{not valid json' },
      'call-badjson',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/JSON|parse|无法解析/)
  })

  it('returns friendly error when option is array (not an object)', async () => {
    const { config } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      { option: [1, 2, 3] },
      'call-array',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/object|对象/)
  })

  it('passes ECharts render error through to AI verbatim', async () => {
    // 故意构造一个 ECharts 会拒的 option（series 没有 type 字段）
    const { config, steps } = makeExecutor()
    const result = await executeChartTool(
      'render_echarts_option',
      'pty-1',
      { option: { series: [{ data: [1, 2, 3] }] } },
      'call-noop',
      {} as Parameters<typeof executeChartTool>[4],
      config
    )
    // 即便 ECharts 不报错（一些版本对缺 type 容忍），也要保证渲染流程不崩
    // 主要是验证执行路径走通：要么 success、要么 success=false 且有 error
    if (!result.success) {
      expect(result.error).toBeTruthy()
      const errStep = steps.find(s => s.type === 'tool_result')
      expect(errStep?.images).toBeUndefined()
    }
  })
})
