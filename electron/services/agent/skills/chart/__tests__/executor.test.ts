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
