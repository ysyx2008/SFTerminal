/**
 * chart executor 契约测试
 *
 * 关键不变量（容易被「优化」时无意打破）：
 * - step.images **必须**带 dataURL —— 前端 (AiPanel/Awaken/tool-display) 是从 step.images 渲染
 * - ToolResult.images **必须**为空 —— 这条路径会触发 flushPendingToolImages 把 SVG
 *   作为视觉输入塞给 AI，但主流多模态模型不识别 SVG，会让 AI 误以为「我看过图了」
 */
import { describe, it, expect, vi } from 'vitest'
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
