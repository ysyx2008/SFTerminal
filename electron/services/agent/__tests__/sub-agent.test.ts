/**
 * sub-agent.ts 单元测试
 *
 * 测试并行子 Agent 的核心功能（独立模式）：
 * - 任务分派、并发控制、结果汇总、错误处理
 * - 独立 [system, user] 开局，不继承父 Agent 对话历史
 * - system prompt 包含运行环境与 aiRules，跨同类型子 Agent byte-exact 一致
 * - 工具白名单：read / write 两类，向后兼容旧值（explore/research → read，edit → write）
 */
import { describe, it, expect, vi } from 'vitest'

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
import * as toolMetadata from '../tool-metadata'
import type { ToolDefinition } from '../../ai.service'
import type { ToolExecutorConfig, AgentConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AgentStep } from '@shared/types'

// ==================== Mock 工厂函数 ====================

const MOCK_TOOL_CALL_ID = 'tc-dispatch-mock'

const DEFAULT_AGENT_CONTEXT: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/Users/test/workspace',
}

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
    getAgentContext: vi.fn().mockReturnValue(DEFAULT_AGENT_CONTEXT),
    getAiRules: vi.fn().mockReturnValue(''),
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
  it('read type (default) should exclude write tools', () => {
    const tools = getSubAgentTools()
    const toolNames = tools.map(t => t.function.name)

    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('file_search')
    expect(toolNames).toContain('exec')
    expect(toolNames).toContain('search_knowledge')
    expect(toolNames).toContain('get_knowledge_doc')

    expect(toolNames).not.toContain('edit_file')
    expect(toolNames).not.toContain('write_text_file')

    // 父专属工具一律不在子 Agent 工具列表
    expect(toolNames).not.toContain('execute_command')
    expect(toolNames).not.toContain('dispatch_agents')
    expect(toolNames).not.toContain('ask_user')
    expect(toolNames).not.toContain('get_terminal_context')
    expect(toolNames).not.toContain('plan')
    expect(toolNames).not.toContain('talk_to_user')
  })

  it('write type should include edit/write tools', () => {
    const tools = getSubAgentTools('write')
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
  })

  it('all sub-agent tool lists should be a contiguous prefix of parent tool list', () => {
    // 工具顺序约定：子 Agent 工具列表是父 Agent 工具列表的连续前缀，
    // 让父/子 Agent 共享 byte-exact 前缀，最大化 prompt cache 命中。
    const parentTools = getAgentTools(undefined, { mode: 'assistant' })
    const parentNames = parentTools.map(t => t.function.name)

    for (const type of ['read', 'write']) {
      const subTools = getSubAgentTools(type)
      const subNames = subTools.map(t => t.function.name)
      const prefix = parentNames.slice(0, subNames.length)
      expect(subNames, `${type} 子 Agent 工具列表应是父 Agent 的连续前缀`).toEqual(prefix)
    }
  })

  it('legacy agent_type values should map to current types', () => {
    // 向后兼容：fork 模式时期使用过 explore / research / edit 三种类型，
    // LLM 凭旧训练习惯调用 explore 等也能 work
    const exploreTools = getSubAgentTools('explore')
    const researchTools = getSubAgentTools('research')
    const readTools = getSubAgentTools('read')
    expect(exploreTools.map(t => t.function.name)).toEqual(readTools.map(t => t.function.name))
    expect(researchTools.map(t => t.function.name)).toEqual(readTools.map(t => t.function.name))

    const editTools = getSubAgentTools('edit')
    const writeTools = getSubAgentTools('write')
    expect(editTools.map(t => t.function.name)).toEqual(writeTools.map(t => t.function.name))
  })

  it('unknown type should fall back to read', () => {
    const tools = getSubAgentTools('nonexistent')
    const readTools = getSubAgentTools('read')
    expect(tools.map(t => t.function.name)).toEqual(readTools.map(t => t.function.name))
  })

  it('each tool should have required schema fields', () => {
    for (const type of ['read', 'write']) {
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
    const subTools = getSubAgentTools('write')

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

  it('should reject when agent context is unavailable', async () => {
    const executor = createMockExecutor({
      getAgentContext: vi.fn().mockReturnValue(undefined)
    })
    const result = await dispatchSubAgents(
      { tasks: [{ description: 'test', prompt: 'test' }] },
      defaultConfig,
      executor,
      MOCK_TOOL_CALL_ID
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Agent 运行上下文')
  })

  it('should validate sub-task prompt is non-empty', async () => {
    const executor = createMockExecutor()
    const result = await dispatchSubAgents({
      tasks: [{ description: 'Bad task', prompt: '  ' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)
    expect(result.success).toBe(false)
    expect(result.error).toContain('prompt')
  })

  it('should dispatch tasks and collect results', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

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

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'dispatch_agents',
        subAgents: expect.any(Array)
      })
    )

    expect(executor.updateStep).toHaveBeenCalled()

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

    expect(result.success).toBe(false)
    expect(result.output).toContain('成功任务')
    expect(result.output).toContain('失败任务')
    expect(result.output).toContain('rate limit')
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
      isAborted = true
      await new Promise(resolve => setTimeout(resolve, 10))
      return { content: 'Done', tool_calls: undefined, finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    })

    await dispatchSubAgents({
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

    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(true)
    expect(result.output).toContain('File analysis complete')

    const updateCalls = (executor.updateStep as any).mock.calls
    const stepsUpdates = updateCalls.filter((c: any[]) => c[1]?.subAgents?.some((sa: any) => sa.steps?.length > 0))
    expect(stepsUpdates.length).toBeGreaterThan(0)

    const finalUpdate = updateCalls.at(-1)
    const finalSubAgent = finalUpdate[1].subAgents?.[0]
    expect(finalSubAgent?.steps).toBeDefined()
    expect(finalSubAgent.steps[0]).toMatchObject({
      tool: 'read_file',
      args: '/test/file.ts'
    })
    expect(['completed', 'failed']).toContain(finalSubAgent.steps[0].status)
  })

  it('should include tool args in sub-agent steps for web_fetch', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          content: '',
          tool_calls: [{
            id: 'tc-fetch',
            type: 'function',
            function: { name: 'web_fetch', arguments: '{"url": "https://example.com/docs"}' }
          }],
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      }
      return {
        content: 'Research done',
        tool_calls: undefined,
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    })

    await dispatchSubAgents({
      tasks: [{ description: '调研', prompt: '请调研竞品' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const finalUpdate = (executor.updateStep as any).mock.calls.at(-1)
    const steps = finalUpdate[1].subAgents?.[0]?.steps
    expect(steps?.[0]).toMatchObject({
      tool: 'web_fetch',
      args: 'https://example.com/docs',
    })
  })

  it('should fall back to switch arg extraction when tool metadata is unavailable', async () => {
    const metaSpy = vi.spyOn(toolMetadata, 'getMetaByName').mockReturnValue(undefined)
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          content: '',
          tool_calls: [{
            id: 'tc-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path": "/test/file.ts"}' }
          }],
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      }
      return {
        content: 'Done',
        tool_calls: undefined,
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    })

    await dispatchSubAgents({
      tasks: [{ description: '读文件', prompt: '请读取文件' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    metaSpy.mockRestore()

    const steps = (executor.updateStep as any).mock.calls.at(-1)[1].subAgents?.[0]?.steps
    expect(steps?.[0]).toMatchObject({
      tool: 'read_file',
      args: '/test/file.ts',
    })
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

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({ description: 'Task 1' })
        ])
      })
    )
  })

  it('should default to read agent type and pass filtered tool list to AI', async () => {
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

    // 子 Agent 看到的是按白名单过滤后的工具列表
    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1]
    const readTools = getSubAgentTools('read')
    expect(toolsPassedToAi).toEqual(readTools)

    // 父专属工具不应在子 Agent 工具列表中
    const subToolNames = toolsPassedToAi.map((t: any) => t.function.name)
    expect(subToolNames).not.toContain('dispatch_agents')
    expect(subToolNames).not.toContain('talk_to_user')
    expect(subToolNames).not.toContain('plan')

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('read')
      })
    )
  })

  it('should pass write-type tool list when agent_type is write', async () => {
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
      agent_type: 'write'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1]
    const subToolNames = toolsPassedToAi.map((t: any) => t.function.name)
    expect(subToolNames).toContain('edit_file')
    expect(subToolNames).toContain('write_text_file')
    expect(subToolNames).not.toContain('dispatch_agents')

    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('write')
      })
    )
  })

  it('should accept legacy agent_type values (explore/research/edit)', async () => {
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    // legacy 'edit' 应映射为 'write'，工具列表与新值一致
    await dispatchSubAgents({
      tasks: [{ description: 'Legacy edit', prompt: 'Edit using legacy type' }],
      agent_type: 'edit'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const toolsPassedToAi = mockAi.chatWithTools.mock.calls[0][1]
    expect(toolsPassedToAi).toEqual(getSubAgentTools('write'))

    // 进度步骤标签使用归一化后的类型名（write）
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('write')
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

  it('should allow per-task agent_type override', async () => {
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
        { description: 'Write task', prompt: 'Edit something', agent_type: 'write' }
      ],
      agent_type: 'read'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    // 第一个子任务用 read 工具集
    const tools1 = mockAi.chatWithTools.mock.calls[0][1]
    const tools1Names = tools1.map((t: any) => t.function.name)
    expect(tools1Names).not.toContain('edit_file')

    // 第二个子任务用 write 工具集
    const tools2 = mockAi.chatWithTools.mock.calls[1][1]
    const tools2Names = tools2.map((t: any) => t.function.name)
    expect(tools2Names).toContain('edit_file')
    expect(tools2Names).toContain('write_text_file')

    // 进度步骤应显示 mixed
    expect(executor.addStep).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('mixed')
      })
    )
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
      agent_type: 'write'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    expect(executor.waitForConfirmation).not.toHaveBeenCalled()
  })

  it('should enforce tool whitelist and block unauthorized tools (defense in depth)', async () => {
    // 工具白名单是后置防线：即使 LLM 通过越狱/历史上下文等方式调用了禁用工具，运行时仍能拦截
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    let callCount = 0
    mockAi.chatWithTools.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // 模拟 LLM 试图调用 read 类型禁用的 edit_file
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
      tasks: [{ description: 'Read task', prompt: 'Analyze files' }],
      agent_type: 'read'
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    expect(result.success).toBe(true)
    expect(mockAi.chatWithTools).toHaveBeenCalledTimes(2)

    const msgs = mockAi.chatWithTools.mock.calls[1][0]
    const toolResult = msgs.find((m: any) => m.role === 'tool' && m.tool_call_id === 'tc-edit')
    expect(toolResult?.content).toContain('不在当前子 Agent 类型的可用范围内')
  })

  // ==================== 独立模式：消息开局结构 ====================

  it('should start with [system, user] only (no inherited parent history)', async () => {
    // 独立模式核心断言：子 Agent 的初始消息 = system prompt + user 任务指令，
    // **不包含**父 Agent 的对话历史（避免身份/工具/历史认知错位的幻觉）
    const executor = createMockExecutor()
    const mockAi = (executor as any)._mockAiService

    mockAi.chatWithTools.mockResolvedValue({
      content: 'Done',
      tool_calls: undefined,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

    await dispatchSubAgents({
      tasks: [{ description: 'Task', prompt: '请分析 /path/file.ts' }]
    }, defaultConfig, executor, MOCK_TOOL_CALL_ID)

    const messages = mockAi.chatWithTools.mock.calls[0][0]
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1]).toEqual({ role: 'user', content: '请分析 /path/file.ts' })

    // 不应携带任何 fork 痕迹（assistant 消息、tool 占位等）
    expect(messages.some((m: any) => m.role === 'assistant')).toBe(false)
    expect(messages.some((m: any) => m.role === 'tool')).toBe(false)
  })

  it('should include host environment in system prompt', async () => {
    // 项目级稳定信息继承：子 Agent system prompt 必须包含运行环境
    const executor = createMockExecutor({
      getAgentContext: vi.fn().mockReturnValue({
        terminalOutput: [],
        systemInfo: { os: 'darwin', shell: 'zsh' },
        terminalType: 'assistant',
        cwd: '/Users/test/proj',
      } as AgentContext)
    })
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

    const systemPrompt = mockAi.chatWithTools.mock.calls[0][0][0].content
    expect(systemPrompt).toContain('darwin')
    expect(systemPrompt).toContain('zsh')
    expect(systemPrompt).toContain('/Users/test/proj')
  })

  it('should include aiRules in system prompt when configured', async () => {
    // aiRules 继承：用户配置的项目级编码约定必须传递给子 Agent
    const executor = createMockExecutor({
      getAiRules: vi.fn().mockReturnValue('用 npm 不用 yarn\n测试用 vitest')
    })
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

    const systemPrompt = mockAi.chatWithTools.mock.calls[0][0][0].content
    expect(systemPrompt).toContain('用户自定义规则')
    expect(systemPrompt).toContain('用 npm 不用 yarn')
    expect(systemPrompt).toContain('测试用 vitest')
  })

  it('should omit aiRules section when not configured', async () => {
    const executor = createMockExecutor({
      getAiRules: vi.fn().mockReturnValue('')
    })
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

    const systemPrompt = mockAi.chatWithTools.mock.calls[0][0][0].content
    expect(systemPrompt).not.toContain('用户自定义规则')
  })

  it('should produce byte-exact same system prompt across sub-agents of same type', async () => {
    // prompt cache 关键不变量：同一父 Agent 下相同类型的子 Agent system prompt 必须完全一致
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

    const sys1 = mockAi.chatWithTools.mock.calls[0][0][0].content
    const sys2 = mockAi.chatWithTools.mock.calls[1][0][0].content
    expect(sys1).toBe(sys2)
  })
})
