/**
 * sub-agent.ts 单元测试
 * 测试并行子 Agent 的核心功能：任务分派、并发控制、结果汇总、错误处理
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { dispatchSubAgents, getSubAgentTools } from '../tools/sub-agent'
import { getAgentTools } from '../tools'
import type { ToolDefinition } from '../../ai.service'
import type { ToolExecutorConfig, AgentConfig } from '../tools/types'
import type { AgentStep } from '@shared/types'

// ==================== Mock 工厂函数 ====================

function createMockAiService() {
  return {
    chatWithTools: vi.fn(),
    chatWithToolsStream: vi.fn(),
    abort: vi.fn()
  }
}

function createMockExecutor(overrides: Partial<ToolExecutorConfig> = {}): ToolExecutorConfig {
  const mockAiService = createMockAiService()

  const steps: AgentStep[] = []
  let stepCounter = 0

  return {
    agentId: 'test-parent',
    terminalService: {
      getTerminalOutput: vi.fn().mockReturnValue([]),
      write: vi.fn(),
      getTerminalType: vi.fn().mockReturnValue('local'),
    } as any,
    addStep: vi.fn((partial: Omit<AgentStep, 'id' | 'timestamp'>) => {
      const step: AgentStep = {
        ...partial,
        id: `step-${++stepCounter}`,
        timestamp: Date.now()
      }
      steps.push(step)
      return step
    }),
    updateStep: vi.fn((stepId: string, updates: Partial<AgentStep>) => {
      const step = steps.find(s => s.id === stepId)
      if (step) Object.assign(step, updates)
    }),
    waitForConfirmation: vi.fn().mockResolvedValue(true),
    isAborted: vi.fn().mockReturnValue(false),
    getHostId: vi.fn().mockReturnValue(undefined),
    hasPendingUserMessage: vi.fn().mockReturnValue(false),
    peekPendingUserMessage: vi.fn().mockReturnValue(undefined),
    consumePendingUserMessage: vi.fn().mockReturnValue(undefined),
    getRealtimeTerminalOutput: vi.fn().mockReturnValue([]),
    getCurrentPlan: vi.fn().mockReturnValue(undefined),
    setCurrentPlan: vi.fn(),
    getTaskMemory: vi.fn().mockReturnValue({
      getTasks: vi.fn().mockReturnValue([]),
      getTask: vi.fn(),
      saveTask: vi.fn(),
      clear: vi.fn(),
    }),
    getAiService: vi.fn().mockReturnValue(mockAiService),
    getActiveProfileId: vi.fn().mockReturnValue('test-profile'),
    historyService: undefined,
    ...overrides,
    // Expose for assertions
    _mockAiService: mockAiService,
    _steps: steps,
  } as any
}

const defaultConfig: AgentConfig = {
  enabled: true,
  maxSteps: 0,
  commandTimeout: 30000,
  autoExecuteSafe: true,
  autoExecuteModerate: true,
  executionMode: 'relaxed',
  debugMode: false
}

// ==================== 测试 ====================

describe('getSubAgentTools', () => {
  it('readonly mode (default) should exclude write tools', () => {
    const tools = getSubAgentTools()
    const toolNames = tools.map(t => t.function.name)

    // 只读工具应包含
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('file_search')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    // 写工具不应包含
    expect(toolNames).not.toContain('edit_file')
    expect(toolNames).not.toContain('write_text_file')

    // 危险/无关工具不应包含
    expect(toolNames).not.toContain('execute_command')
    expect(toolNames).not.toContain('dispatch_agents')
    expect(toolNames).not.toContain('ask_user')
    expect(toolNames).not.toContain('get_terminal_context')
    expect(toolNames).not.toContain('remember_info')
    expect(toolNames).not.toContain('plan')
    expect(toolNames).not.toContain('talk_to_user')
  })

  it('writable mode should include write tools', () => {
    const tools = getSubAgentTools(false)
    const toolNames = tools.map(t => t.function.name)

    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('edit_file')
    expect(toolNames).toContain('write_text_file')
    expect(toolNames).toContain('file_search')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    // 危险/无关工具仍不包含
    expect(toolNames).not.toContain('dispatch_agents')
    expect(toolNames).not.toContain('ask_user')
  })

  it('each tool should have required schema fields', () => {
    for (const readonly of [true, false]) {
      const tools = getSubAgentTools(readonly)
      for (const tool of tools) {
        expect(tool.type).toBe('function')
        expect(tool.function.name).toBeTruthy()
        expect(tool.function.description).toBeTruthy()
        expect(tool.function.parameters).toBeDefined()
        expect(tool.function.parameters.type).toBe('object')
      }
    }
  })

  it('parameter schemas should match main agent tools', () => {
    const mainTools = getAgentTools(undefined, { mode: 'assistant' })
    // 测试读写模式（覆盖更多工具）
    const subTools = getSubAgentTools(false)

    for (const subTool of subTools) {
      const mainTool = mainTools.find(t => t.function.name === subTool.function.name)
      expect(mainTool, `Tool "${subTool.function.name}" should exist in main agent tools`).toBeDefined()
      expect(subTool.function.parameters).toEqual(mainTool!.function.parameters)
    }
  })
})

describe('dispatchSubAgents', () => {
  it('should reject empty tasks array', async () => {
    const executor = createMockExecutor()
    const result = await dispatchSubAgents({ tasks: [] }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('非空数组')
  })

  it('should reject missing tasks parameter', async () => {
    const executor = createMockExecutor()
    const result = await dispatchSubAgents({}, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('非空数组')
  })

  it('should reject more than 10 tasks', async () => {
    const executor = createMockExecutor()
    const tasks = Array.from({ length: 11 }, (_, i) => ({
      description: `Task ${i}`,
      prompt: `Do task ${i}`
    }))
    const result = await dispatchSubAgents({ tasks }, defaultConfig, executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('10')
  })

  it('should reject when AI service is unavailable', async () => {
    const executor = createMockExecutor({
      getAiService: vi.fn().mockReturnValue(undefined)
    })
    const result = await dispatchSubAgents(
      { tasks: [{ description: 'test', prompt: 'test' }] },
      defaultConfig,
      executor
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('AI service')
  })

  it('should dispatch tasks and collect results', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    // 每个子 Agent 第一轮返回最终结果（无工具调用）
    mockAi.chatWithTools.mockResolvedValue({
      content: 'Task completed successfully',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    })

    const result = await dispatchSubAgents({
      tasks: [
        { description: '分析文件 A', prompt: '请分析 /path/a.ts' },
        { description: '分析文件 B', prompt: '请分析 /path/b.ts' }
      ]
    }, defaultConfig, executor)

    expect(result.success).toBe(true)
    expect(result.output).toContain('分析文件 A')
    expect(result.output).toContain('分析文件 B')
    expect(result.output).toContain('Task completed successfully')

    // AI 应被调用 2 次（每个子任务 1 次）
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(2)
  })

  it('should create progress step with subAgents field', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Task 1', prompt: 'Do task 1' }]
    }, defaultConfig, executor)

    // addStep 应被调用一次（dispatch_agents 工具的 tool_call 步骤）
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'dispatch_agents',
        subAgents: expect.any(Array)
      })
    )

    // updateStep 应被调用来更新进度（running → completed）
    expect(executor.updateStep).toHaveBeenCalled()

    // 最终 updateStep 调用应包含 completed 状态
    const lastUpdateCall = (executor.updateStep as any).mock.calls.at(-1)
    expect(lastUpdateCall).toBeDefined()
    const lastSubAgents = lastUpdateCall[1].subAgents
    if (lastSubAgents) {
      expect(lastSubAgents[0]).toMatchObject({
        id: 'sub-1',
        description: 'Task 1',
        status: 'completed'
      })
    }
  })

  it('should handle sub-agent failures gracefully', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { content: 'Success', tool_calls: undefined, finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      }
      throw new Error('API rate limit exceeded')
    })

    const result = await dispatchSubAgents({
      tasks: [
        { description: '成功任务', prompt: 'Will succeed' },
        { description: '失败任务', prompt: 'Will fail' }
      ]
    }, defaultConfig, executor)

    // 整体标记为非全成功
    expect(result.success).toBe(false)
    expect(result.output).toContain('成功任务')
    expect(result.output).toContain('失败任务')
    expect(result.output).toContain('rate limit')
    // error 字段应有明确的失败计数信息
    expect(result.error).toContain('1/2')
  })

  it('should respect max_concurrent parameter', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    const concurrencyTracker: number[] = []
    let activeConcurrency = 0

    mockAi.chatWithTools.mockImplementation(async () => {
      activeConcurrency++
      concurrencyTracker.push(activeConcurrency)
      await new Promise(resolve => setTimeout(resolve, 50))
      activeConcurrency--
      return { content: 'Done', tool_calls: undefined, finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    })

    await dispatchSubAgents({
      tasks: [
        { description: 'T1', prompt: 'P1' },
        { description: 'T2', prompt: 'P2' },
        { description: 'T3', prompt: 'P3' },
        { description: 'T4', prompt: 'P4' }
      ],
      max_concurrent: 2
    }, defaultConfig, executor)

    // 并发度不应超过 2
    expect(Math.max(...concurrencyTracker)).toBeLessThanOrEqual(2)
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(4)
  })

  it('should abort sub-agents when parent is aborted', async () => {
    let isAborted = false
    const executor = createMockExecutor({
      isAborted: vi.fn(() => isAborted)
    })
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockImplementation(async () => {
      // 在第一个子任务完成后标记为 aborted
      isAborted = true
      await new Promise(resolve => setTimeout(resolve, 10))
      return { content: 'Done', tool_calls: undefined, finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    })

    const result = await dispatchSubAgents({
      tasks: [
        { description: 'T1', prompt: 'P1' },
        { description: 'T2', prompt: 'P2' },
        { description: 'T3', prompt: 'P3' }
      ],
      max_concurrent: 1
    }, defaultConfig, executor)

    // 由于 max_concurrent=1 且第一批后 abort，后续批次不执行
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(1)
  })

  it('should handle sub-agent with tool calls', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // 第一轮：要求读取文件
        return {
          content: '',
          tool_calls: [{
            id: 'tc-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path": "/test/file.ts"}' }
          }],
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        }
      }
      // 第二轮：返回最终结果
      return {
        content: 'File analysis complete: 50 lines of code',
        tool_calls: undefined,
        finish_reason: 'stop',
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 }
      }
    })

    const result = await dispatchSubAgents({
      tasks: [{ description: '分析文件', prompt: '请分析 /test/file.ts' }]
    }, defaultConfig, executor)

    // AI 被调用 2 次（一轮工具调用 + 一轮最终结果）
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(true)
    expect(result.output).toContain('File analysis complete')

    // updateStep 应包含 steps 字段（工具执行记录）
    const updateCalls = (executor.updateStep as any).mock.calls
    const stepsUpdates = updateCalls.filter((c: any[]) => c[1]?.subAgents?.some((sa: any) => sa.steps?.length > 0))
    expect(stepsUpdates.length).toBeGreaterThan(0)

    // 最终结果中应包含 read_file 步骤
    const finalUpdate = updateCalls.at(-1)
    const finalSubAgent = finalUpdate[1].subAgents?.[0]
    expect(finalSubAgent?.steps).toBeDefined()
    expect(finalSubAgent.steps[0]).toMatchObject({
      tool: 'read_file',
      args: '/test/file.ts'
    })
    expect(['completed', 'failed']).toContain(finalSubAgent.steps[0].status)
  })

  it('should use default description when not provided', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: '', prompt: 'Do something' }]
    }, defaultConfig, executor)

    // addStep 应使用默认描述
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({ description: 'Task 1' })
        ])
      })
    )
  })

  it('should default to readonly mode', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Read task', prompt: 'Read something' }]
    }, defaultConfig, executor)

    // 验证 AI 收到的工具集不包含写工具
    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1] as ToolDefinition[]
    const toolNames = toolsPassedToAi.map((t: ToolDefinition) => t.function.name)
    expect(toolNames).not.toContain('edit_file')
    expect(toolNames).not.toContain('write_text_file')
    expect(toolNames).toContain('read_file')

    // 进度步骤应显示"只读"
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('只读')
      })
    )
  })

  it('should include write tools when readonly=false', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Write task', prompt: 'Edit something' }],
      readonly: false
    }, defaultConfig, executor)

    // 验证 AI 收到的工具集包含写工具
    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1] as ToolDefinition[]
    const toolNames = toolsPassedToAi.map((t: ToolDefinition) => t.function.name)
    expect(toolNames).toContain('edit_file')
    expect(toolNames).toContain('write_text_file')
    expect(toolNames).toContain('read_file')

    // 进度步骤应显示"读写"
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('读写')
      })
    )
  })
})
