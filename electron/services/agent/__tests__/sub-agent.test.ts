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

const MOCK_TOOL_CALL_ID = 'tc-dispatch-mock'

const DEFAULT_PARENT_MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: '请帮我分析项目' },
  { role: 'assistant' as const, content: '好的，我来分派子任务。', tool_calls: [
    { id: MOCK_TOOL_CALL_ID, type: 'function' as const, function: { name: 'dispatch_agents', arguments: '{}' } }
  ] }
]

const DEFAULT_PARENT_TOOLS: ToolDefinition[] = getAgentTools(undefined, { mode: 'assistant' })

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
    getParentContext: vi.fn().mockReturnValue({
      messages: DEFAULT_PARENT_MESSAGES,
      tools: DEFAULT_PARENT_TOOLS
    }),
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
  it('explore type (default) should exclude write tools', () => {
    const tools = getSubAgentTools()
    const toolNames = tools.map(t => t.function.name)

    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('file_search')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    expect(toolNames).not.toContain('edit_file')
    expect(toolNames).not.toContain('write_text_file')

    expect(toolNames).not.toContain('execute_command')
    expect(toolNames).not.toContain('dispatch_agents')
    expect(toolNames).not.toContain('ask_user')
    expect(toolNames).not.toContain('get_terminal_context')
    expect(toolNames).not.toContain('remember_info')
    expect(toolNames).not.toContain('plan')
    expect(toolNames).not.toContain('talk_to_user')
  })

  it('edit type should include write tools', () => {
    const tools = getSubAgentTools('edit')
    const toolNames = tools.map(t => t.function.name)

    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('edit_file')
    expect(toolNames).toContain('write_text_file')
    expect(toolNames).toContain('file_search')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    expect(toolNames).not.toContain('dispatch_agents')
    expect(toolNames).not.toContain('ask_user')
    expect(toolNames).not.toContain('talk_to_user')
    expect(toolNames).not.toContain('plan')
    expect(toolNames).not.toContain('remember_info')
  })

  it('all sub-agent tool lists should be a contiguous prefix of parent tool list', () => {
    // 工具顺序约定：子 Agent 工具列表是父 Agent 工具列表的连续前缀，
    // 让父/子 Agent 共享 byte-exact 前缀，最大化 prompt cache 命中。
    const parentTools = getAgentTools(undefined, { mode: 'assistant' })
    const parentNames = parentTools.map(t => t.function.name)

    for (const type of ['explore', 'edit', 'research']) {
      const subTools = getSubAgentTools(type)
      const subNames = subTools.map(t => t.function.name)
      const prefix = parentNames.slice(0, subNames.length)
      expect(subNames, `${type} 子 Agent 工具列表应是父 Agent 的连续前缀`).toEqual(prefix)
    }
  })

  it('research type should have focused tool set', () => {
    const tools = getSubAgentTools('research')
    const toolNames = tools.map(t => t.function.name)

    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    expect(toolNames).toContain('file_search')

    // research 不包含写工具
    expect(toolNames).not.toContain('edit_file')
    expect(toolNames).not.toContain('write_text_file')
  })

  it('unknown type should fall back to explore', () => {
    const tools = getSubAgentTools('nonexistent')
    const exploreTools = getSubAgentTools('explore')
    const toolNames = tools.map(t => t.function.name)
    const exploreNames = exploreTools.map(t => t.function.name)
    expect(toolNames).toEqual(exploreNames)
  })

  it('each tool should have required schema fields', () => {
    for (const type of ['explore', 'edit', 'research']) {
      const tools = getSubAgentTools(type)
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
    const subTools = getSubAgentTools('edit')

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
    const result = await dispatchSubAgents({ tasks: [] }, defaultConfig, executor, MOCK_TOOL_CALL_ID)
    expect(result.success).toBe(false)
    expect(result.error).toContain('非空数组')
  })

  it('should reject missing tasks parameter', async () => {
    const executor = createMockExecutor()
    const result = await dispatchSubAgents({}, defaultConfig, executor, MOCK_TOOL_CALL_ID)
    expect(result.success).toBe(false)
    expect(result.error).toContain('非空数组')
  })

  it('should reject more than 10 tasks', async () => {
    const executor = createMockExecutor()
    const tasks = Array.from({ length: 11 }, (_, i) => ({
      description: `Task ${i}`,
      prompt: `Do task ${i}`
    }))
    const result = await dispatchSubAgents({ tasks }, defaultConfig, executor, MOCK_TOOL_CALL_ID)
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
      executor,
      MOCK_TOOL_CALL_ID
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('AI service')
  })

  it('should reject when parent context is unavailable', async () => {
    const executor = createMockExecutor({
      getParentContext: vi.fn().mockReturnValue(undefined)
    })
    const result = await dispatchSubAgents(
      { tasks: [{ description: 'test', prompt: 'test' }] },
      defaultConfig,
      executor,
      MOCK_TOOL_CALL_ID
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('父 Agent 上下文')
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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    // addStep 应使用默认描述
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({ description: 'Task 1' })
        ])
      })
    )
  })

  it('should default to explore agent type and pass filtered tool list to AI', async () => {
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
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    // 子 Agent 看到的是按白名单过滤后的工具列表（不是父 Agent 的完整工具列表）
    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1]
    const exploreTools = getSubAgentTools('explore')
    expect(toolsPassedToAi).toEqual(exploreTools)
    expect(toolsPassedToAi).not.toBe(DEFAULT_PARENT_TOOLS)

    // 父专属工具不应在子 Agent 工具列表中
    const subToolNames = toolsPassedToAi.map((t: any) => t.function.name)
    expect(subToolNames).not.toContain('dispatch_agents')
    expect(subToolNames).not.toContain('talk_to_user')
    expect(subToolNames).not.toContain('plan')

    // 指令消息应包含 explore 类型约束
    const messagesPassedToAi = mockAi.chatWithTools.mock.calls[0][0]
    const directive = messagesPassedToAi[messagesPassedToAi.length - 1].content
    expect(directive).toContain('explore')

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('explore')
      })
    )
  })

  it('should pass edit-type tool list when agent_type is edit', async () => {
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
      agent_type: 'edit'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    // 子 Agent 工具列表应包含 edit 类型工具，且不含父专属工具
    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1]
    const subToolNames = toolsPassedToAi.map((t: any) => t.function.name)
    expect(subToolNames).toContain('edit_file')
    expect(subToolNames).toContain('write_text_file')
    expect(subToolNames).not.toContain('dispatch_agents')

    // 指令消息应包含 edit 类型字样
    const messagesPassedToAi = mockAi.chatWithTools.mock.calls[0][0]
    const directive = messagesPassedToAi[messagesPassedToAi.length - 1].content
    expect(directive).toContain('edit')

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('edit')
      })
    )
  })

  it('should share byte-exact tool list across sub-agents of same type', async () => {
    // prompt cache 命中前提：相同类型的多个子 Agent 工具列表必须 byte-exact 一致
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [
        { description: 'Task A', prompt: 'Do A' },
        { description: 'Task B', prompt: 'Do B' }
      ]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const tools1 = mockAi.chatWithTools.mock.calls[0][1]
    const tools2 = mockAi.chatWithTools.mock.calls[1][1]
    expect(JSON.stringify(tools1)).toBe(JSON.stringify(tools2))
  })

  it('should allow per-task agent_type override in directive', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [
        { description: 'Read task', prompt: 'Read something' },
        { description: 'Edit task', prompt: 'Edit something', agent_type: 'edit' }
      ],
      agent_type: 'explore'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    // 第一个子任务指令应包含 explore
    const msgs1 = mockAi.chatWithTools.mock.calls[0][0]
    expect(msgs1[msgs1.length - 1].content).toContain('explore')

    // 第二个子任务指令应包含 edit
    const msgs2 = mockAi.chatWithTools.mock.calls[1][0]
    expect(msgs2[msgs2.length - 1].content).toContain('edit')

    // 进度步骤应显示 mixed
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('mixed')
      })
    )
  })

  it('should validate sub-task prompt is non-empty', async () => {
    const executor = createMockExecutor()
    const result = await dispatchSubAgents({
      tasks: [{ description: 'Bad task', prompt: '  ' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)
    expect(result.success).toBe(false)
    expect(result.error).toContain('prompt')
  })

  // ==================== Fork 上下文继承测试 ====================

  it('should inherit parent message history via fork', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Task', prompt: 'Do something' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const messagesPassedToAi = mockAi.chatWithTools.mock.calls[0][0]

    // 应包含父的系统提示
    expect(messagesPassedToAi[0]).toMatchObject({ role: 'system', content: 'You are a helpful assistant.' })

    // 应包含父的用户消息
    expect(messagesPassedToAi[1]).toMatchObject({ role: 'user', content: '请帮我分析项目' })

    // 应包含 fork 占位 tool_result
    const toolResults = messagesPassedToAi.filter((m: any) => m.role === 'tool')
    expect(toolResults.length).toBe(1)
    expect(toolResults[0].tool_call_id).toBe(MOCK_TOOL_CALL_ID)

    // 最后一条应该是子 Agent 的指令
    const lastMsg = messagesPassedToAi[messagesPassedToAi.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toContain('Do something')
    expect(lastMsg.content).toContain('explore')
  })

  it('should share same message prefix across multiple sub-agents', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [
        { description: 'Task A', prompt: 'Do A' },
        { description: 'Task B', prompt: 'Do B' }
      ]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const msgs1 = mockAi.chatWithTools.mock.calls[0][0]
    const msgs2 = mockAi.chatWithTools.mock.calls[1][0]

    // 前缀部分（除最后一条 user 指令外）应完全一致
    const prefix1 = msgs1.slice(0, -1)
    const prefix2 = msgs2.slice(0, -1)
    expect(prefix1).toEqual(prefix2)

    // 最后一条各自包含不同任务
    expect(msgs1[msgs1.length - 1].content).toContain('Do A')
    expect(msgs2[msgs2.length - 1].content).toContain('Do B')
  })

  it('should enforce tool whitelist and block unauthorized tools (defense in depth)', async () => {
    // 工具白名单是后置防线：即使 LLM 通过越狱/历史上下文等方式调用了禁用工具，运行时仍能拦截
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // 模拟 LLM 试图调用 explore 类型禁用的 edit_file
        return {
          content: '',
          tool_calls: [{ id: 'tc-edit', type: 'function', function: { name: 'edit_file', arguments: '{"path": "/test.ts", "old_text": "a", "new_text": "b"}' } }],
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
        }
      }
      return {
        content: 'OK, read-only mode noted',
        tool_calls: undefined,
        finish_reason: 'stop',
        usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }
      }
    })

    const result = await dispatchSubAgents({
      tasks: [{ description: 'Explore task', prompt: 'Analyze files' }],
      agent_type: 'explore'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    expect(result.success).toBe(true)
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(2)

    const msgs = mockAi.chatWithTools.mock.calls[1][0]
    const toolResult = msgs.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc-edit')
    expect(toolResult?.content).toContain('不在当前子 Agent 类型的可用范围内')
  })

  it('should not invoke parent waitForConfirmation (sub-agent auto-handles)', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Task completed',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Test task', prompt: 'Do something' }],
      agent_type: 'edit'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    expect(executor.waitForConfirmation).not.toHaveBeenCalled()
  })

  it('should handle multiple pending tool_calls with placeholders', async () => {
    const messagesWithMultipleCalls = [
      { role: 'system' as const, content: 'System prompt' },
      { role: 'user' as const, content: 'User request' },
      { role: 'assistant' as const, content: '', tool_calls: [
        { id: 'tc-read', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
        { id: 'tc-dispatch-2', type: 'function' as const, function: { name: 'dispatch_agents', arguments: '{}' } },
      ] },
      { role: 'tool' as const, tool_call_id: 'tc-read', content: 'file contents' },
    ]

    const executor = createMockExecutor({
      getParentContext: vi.fn().mockReturnValue({
        messages: messagesWithMultipleCalls,
        tools: DEFAULT_PARENT_TOOLS
      })
    })
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Task', prompt: 'Do it' }]
    }, defaultConfig, executor, 'tc-dispatch-2')

    const messagesPassedToAi = mockAi.chatWithTools.mock.calls[0][0]

    const readResult = messagesPassedToAi.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc-read')
    expect(readResult?.content).toBe('file contents')

    const dispatchResult = messagesPassedToAi.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc-dispatch-2')
    expect(dispatchResult).toBeDefined()
    expect(dispatchResult?.content).toContain('子任务已分派')
  })
})
