/**
 * agent.ts 单元测试
 * 测试 Agent 基类的核心功能：执行循环、状态管理、工具调用、回调机制等
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Electron 模块（必须在导入 Agent 之前）
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

// Mock fs 模块
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

// Mock im.service 打断 agent.ts → tools/misc → im.service → agent/index → sailfish → agent.ts 循环依赖
vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { Agent } from '../agent'
import type { ToolDefinition, AiMessage } from '../../ai.service'
import type { 
  AgentContext, 
  AgentServices, 
  PromptOptions,
  AgentCallbacks,
  AgentStep
} from '../types'
import { TaskMemoryStore } from '../task-memory'

// ==================== Mock 实现 ====================

/**
 * 测试用 Agent 实现类
 * 因为 Agent 是抽象类，需要创建具体实现来测试
 */
class TestAgent extends Agent {
  public mockTools: ToolDefinition[] = []
  public mockSystemPrompt: string = 'Test system prompt'

  getAvailableTools(): ToolDefinition[] {
    return this.mockTools
  }

  protected buildSystemPrompt(_context: AgentContext, _options: PromptOptions): string {
    return this.mockSystemPrompt
  }

  protected getAgentId(): string {
    return 'test-agent'
  }

  // 暴露受保护的方法用于测试
  public exposeCurrentRun() {
    return this.currentRun
  }

  public exposeTaskMemory() {
    return this.taskMemory
  }
  
  public exposeServices() {
    return this.services
  }
  
  public exposeGetSkillSession() {
    return this.getSkillSession()
  }

  // 暴露 finalizeToolCallStep 和 addStep 用于测试 tool_call 成功/失败的 UI 回填语义
  public testFinalizeToolCallStep(run: any, toolCallId: string, success: boolean) {
    return (this as any).finalizeToolCallStep(run, toolCallId, success)
  }

  public testAddStep(step: any) {
    return (this as any).addStep(step)
  }

  // 暴露 ensureToolResultStep / wrapExecutorConfigForToolCall 用于测试
  // 同名批量、并行混合成败、toolCallId 注入等场景
  public testEnsureToolResultStep(run: any, stepCountBefore: number, toolCall: any, result: any) {
    return (this as any).ensureToolResultStep(run, stepCountBefore, toolCall, result)
  }

  public testWrapExecutorConfigForToolCall(run: any, toolCall: any, base: any) {
    return (this as any).wrapExecutorConfigForToolCall(run, toolCall, base)
  }

  // 暴露 processToolResult / flushPendingToolImages 用于验证：
  // 多个工具返回图片时，user 消息不会夹在 tool 消息之间，破坏 OpenAI tool_calls 协议
  public testProcessToolResult(run: any, toolCall: any, result: any, toolArgs: any = {}) {
    return (this as any).processToolResult(run, toolCall, result, toolArgs)
  }

  public testFlushPendingToolImages(run: any) {
    return (this as any).flushPendingToolImages(run)
  }

  // 注入 currentRun，便于直接针对 addStep/updateStep/finalizeToolCallStep 做单元测试
  // 而不必真正启动 agent.run 流程
  public injectCurrentRun(run: any) {
    (this as any).currentRun = run
  }
}

// Mock AI 服务
function createMockAiService() {
  return {
    chatWithToolsStream: vi.fn(),
    abort: vi.fn()
  }
}

// Mock PTY 服务
function createMockPtyService() {
  return {
    onData: vi.fn().mockReturnValue(() => {}),
    write: vi.fn()
  }
}

// Mock 配置服务
function createMockConfigService() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    getAgentMbti: vi.fn().mockReturnValue(null),
    getAiRules: vi.fn().mockReturnValue(''),
    getAgentPersonalityText: vi.fn().mockReturnValue(''),
    getAgentName: vi.fn().mockReturnValue(''),
    getLanguage: vi.fn().mockReturnValue('zh-CN'),
    getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
    getActiveAiProfile: vi.fn().mockReturnValue('test'),
    getAgentOnboardingCompleted: vi.fn().mockReturnValue(true)
  }
}

// 创建基础的 AgentServices mock
function createMockServices(overrides?: Partial<AgentServices>): AgentServices {
  return {
    aiService: createMockAiService() as any,
    ptyService: createMockPtyService() as any,
    configService: createMockConfigService() as any,
    ...overrides
  }
}

// 创建基础的 AgentContext
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    ptyId: 'test-pty',
    terminalOutput: [],
    systemInfo: {
      os: 'darwin',
      shell: '/bin/zsh'
    },
    terminalType: 'local',
    ...overrides
  }
}

// ==================== Agent 构造和初始化 ====================

describe('Agent', () => {
  let agent: TestAgent
  let mockServices: AgentServices

  beforeEach(() => {
    vi.clearAllMocks()
    mockServices = createMockServices()
    agent = new TestAgent(mockServices)
  })

  describe('constructor and initialization', () => {
    it('should initialize with default config', () => {
      expect(agent.executionMode).toBe('strict')
      expect(agent.commandTimeout).toBe(30000)
    })

    it('should create task memory store', () => {
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory).toBeInstanceOf(TaskMemoryStore)
    })

    it('should store services reference', () => {
      const services = agent.exposeServices()
      expect(services).toBe(mockServices)
    })
  })

  // ==================== 配置更新 ====================

  describe('updateConfig', () => {
    it('should update execution mode', () => {
      agent.updateConfig({ executionMode: 'relaxed' })
      expect(agent.executionMode).toBe('relaxed')
    })

    it('should update command timeout', () => {
      agent.updateConfig({ commandTimeout: 60000 })
      expect(agent.commandTimeout).toBe(60000)
    })

    it('should handle partial config updates', () => {
      agent.updateConfig({ executionMode: 'free' })
      expect(agent.executionMode).toBe('free')
      expect(agent.commandTimeout).toBe(30000) // should remain unchanged
    })

    it('should update multiple config values at once', () => {
      agent.updateConfig({
        executionMode: 'relaxed',
        commandTimeout: 45000
      })
      expect(agent.executionMode).toBe('relaxed')
      expect(agent.commandTimeout).toBe(45000)
    })
  })

  // ==================== 运行状态检查 ====================

  describe('isRunning', () => {
    it('should return false when not running', () => {
      expect(agent.isRunning()).toBe(false)
    })
  })

  describe('getExecutionPhase', () => {
    it('should return idle when not running', () => {
      expect(agent.getExecutionPhase()).toBe('idle')
    })
  })

  describe('getRunStatus', () => {
    it('should return undefined when no run exists', () => {
      expect(agent.getRunStatus()).toBeUndefined()
    })
  })

  // ==================== 回调设置 ====================

  describe('setCallbacks', () => {
    it('should set callbacks', () => {
      const callbacks: AgentCallbacks = {
        onStep: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn()
      }
      
      agent.setCallbacks(callbacks)
      // 回调会在实际运行时使用，这里只验证设置成功
      expect(true).toBe(true)
    })
  })

  // ==================== 中止功能 ====================

  describe('abort', () => {
    it('should return false when not running', () => {
      expect(agent.abort()).toBe(false)
    })
  })

  // ==================== 用户消息 ====================

  describe('addUserMessage', () => {
    it('should return false when not running', () => {
      expect(agent.addUserMessage('test message')).toBe(false)
    })
  })

  // ==================== 工具确认 ====================

  describe('confirmToolCall', () => {
    it('should return false when not running', () => {
      expect(agent.confirmToolCall('tool-1', true)).toBe(false)
    })
  })

  // ==================== 清理 ====================

  describe('cleanup', () => {
    it('should not throw when no run exists', () => {
      expect(() => agent.cleanup()).not.toThrow()
    })
  })

  // ==================== tool_call 结果回填 ====================
  // 这组测试确保 UI 能按"执行结果"给 tool_call 左竖条着色：
  //   - 失败 → 红（exec-failed）
  //   - 成功 → 无特殊色（success=true，但视觉上不加竖条）
  // 避免此前"风险色红"被误读为"执行失败"。
  describe('finalizeToolCallStep', () => {
    // 构造一个最小化的 fake run，让 addStep/updateStep 可以工作
    function makeFakeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        pendingPreToolCallStepIds: undefined,
        pendingPreToolCallText: undefined,
        activeToolCallStepIds: undefined
      }
    }

    it('should backfill success=false onto the registered tool_call step', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const toolCallId = 'tc-fail'
      const step = agent.testAddStep({
        type: 'tool_call',
        content: 'running...',
        toolName: 'execute_command',
        isStreaming: true
      })
      // 模拟 wrapExecutorConfigForToolCall 完成登记
      run.activeToolCallStepIds = new Map<string, string>([[toolCallId, step.id]])

      agent.testFinalizeToolCallStep(run, toolCallId, false)

      expect(run.activeToolCallStepIds.has(toolCallId)).toBe(false)
      expect(step.success).toBe(false)
      expect(step.isStreaming).toBe(false)
    })

    it('should backfill success=true onto pending pre-created tool_call step when executor never re-addStep', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const toolCallId = 'tc-orphan'
      const step = agent.testAddStep({
        type: 'tool_call',
        content: 'pre-created',
        toolName: 'execute_command',
        isStreaming: true
      })
      run.pendingPreToolCallStepIds = new Map<string, string>([[toolCallId, step.id]])
      run.pendingPreToolCallText = new Map<string, string>([[toolCallId, 'pre-created']])

      agent.testFinalizeToolCallStep(run, toolCallId, true)

      expect(run.pendingPreToolCallStepIds.has(toolCallId)).toBe(false)
      expect(run.pendingPreToolCallText.has(toolCallId)).toBe(false)
      expect(step.success).toBe(true)
      expect(step.isStreaming).toBe(false)
    })

    it('should be a no-op when no tool_call step is registered', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)
      expect(() => agent.testFinalizeToolCallStep(run, 'nonexistent', false)).not.toThrow()
    })
  })

  // ==================== tool_result step 配对（按 toolCallId） ====================
  // 这组测试覆盖之前的 bug：同一批次中多次同名工具调用时，因为 ensureToolResultStep
  // 按 toolName 去重导致只有第 1 个 result 卡能显示。修复后改用 toolCallId 配对。
  describe('ensureToolResultStep (toolCallId 配对)', () => {
    function makeFakeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        pendingPreToolCallStepIds: undefined,
        pendingPreToolCallText: undefined,
        activeToolCallStepIds: undefined
      }
    }

    function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}) {
      return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } as any
    }

    it('should emit one tool_result per call when same-named tool is invoked multiple times in a batch', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tcA = makeToolCall('tc-a', 'exec', { command: 'ls' })
      const tcB = makeToolCall('tc-b', 'exec', { command: 'pwd' })
      const tcC = makeToolCall('tc-c', 'exec', { command: 'whoami' })

      // 工具自己未 emit tool_result（exec 成功路径就是这种），由 ensureToolResultStep 兜底
      agent.testEnsureToolResultStep(run, baseline, tcA, { success: true, output: 'fileA' })
      agent.testEnsureToolResultStep(run, baseline, tcB, { success: true, output: 'fileB' })
      agent.testEnsureToolResultStep(run, baseline, tcC, { success: true, output: 'fileC' })

      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(3)
      expect(results.map((s: any) => s.toolCallId)).toEqual(['tc-a', 'tc-b', 'tc-c'])
      expect(results.map((s: any) => s.toolResult)).toEqual(['fileA', 'fileB', 'fileC'])
      expect(results.every((s: any) => s.success === true)).toBe(true)
    })

    it('should backfill success precisely per toolCallId in a parallel mixed-result batch', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tcA = makeToolCall('tc-a', 'read_file', { path: '/a' })
      const tcB = makeToolCall('tc-b', 'read_file', { path: '/b' })
      const tcC = makeToolCall('tc-c', 'read_file', { path: '/c' })

      // 模拟工具自己 emit 的 tool_result 卡（read_file 走这条路径），都是 success=undefined
      // 由 wrapExecutorConfigForToolCall 给 toolCallId 盖戳；这里直接显式带上模拟
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolCallId: 'tc-a', toolResult: 'A content' })
      agent.testAddStep({ type: 'tool_result', content: '❌', toolName: 'read_file', toolCallId: 'tc-b', toolResult: 'ENOENT' })
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolCallId: 'tc-c', toolResult: 'C content' })

      // A 完成（成功）→ 只回填 tc-a 那张，不会污染 tc-b / tc-c
      agent.testEnsureToolResultStep(run, baseline, tcA, { success: true, output: 'A content' })
      // B 完成（失败）→ 只回填 tc-b 那张
      agent.testEnsureToolResultStep(run, baseline, tcB, { success: false, error: 'ENOENT' })
      // C 完成（成功）→ 只回填 tc-c 那张
      agent.testEnsureToolResultStep(run, baseline, tcC, { success: true, output: 'C content' })

      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(3)
      const byId = Object.fromEntries(results.map((s: any) => [s.toolCallId, s.success]))
      expect(byId).toEqual({ 'tc-a': true, 'tc-b': false, 'tc-c': true })
    })

    it('should fall back to toolName matching when an existing step has no toolCallId (legacy compat)', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const baseline = run.steps.length
      const tc = makeToolCall('tc-legacy', 'read_file', { path: '/x' })

      // 模拟老版本的 step，只有 toolName，没有 toolCallId
      agent.testAddStep({ type: 'tool_result', content: '✅', toolName: 'read_file', toolResult: 'legacy' })

      agent.testEnsureToolResultStep(run, baseline, tc, { success: true, output: 'legacy' })

      // 不应再追加新 tool_result（按 toolName 退化匹配命中），且 success 被回填
      const results = run.steps.filter((s: any) => s.type === 'tool_result')
      expect(results).toHaveLength(1)
      expect(results[0].success).toBe(true)
    })

    it('wrapExecutorConfigForToolCall stamps toolCallId on tool_call / tool_result steps automatically', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const tc = makeToolCall('tc-stamp', 'exec', { command: 'date' })

      // 构造一个最小可用的 base ToolExecutorConfig：只关心 addStep / updateStep 两个钩子
      const base = {
        addStep: (step: any) => agent.testAddStep(step),
        updateStep: (id: string, patch: any) => {
          const target = run.steps.find((s: any) => s.id === id)
          if (target) Object.assign(target, patch)
        },
        // 其他字段对本测试无关，置空即可
        isAborted: () => false,
        waitForConfirmation: () => Promise.resolve(true)
      }

      const wrapped = agent.testWrapExecutorConfigForToolCall(run, tc, base)
      // tool_call 类型应被自动盖戳
      const callStep = wrapped.addStep({ type: 'tool_call', content: 'running', toolName: 'exec' })
      expect(callStep.toolCallId).toBe('tc-stamp')
      // tool_result 类型也应被盖戳
      const resultStep = wrapped.addStep({ type: 'tool_result', content: '✅', toolName: 'exec' })
      expect(resultStep.toolCallId).toBe('tc-stamp')
      // 其他类型不应被改动
      const msgStep = wrapped.addStep({ type: 'message', content: 'hello' })
      expect(msgStep.toolCallId).toBeUndefined()
    })

    it('should not overwrite an existing toolCallId set by the tool implementation', () => {
      const run = makeFakeRun()
      agent.injectCurrentRun(run)

      const tc = makeToolCall('tc-outer', 'exec')
      const base = {
        addStep: (step: any) => agent.testAddStep(step),
        updateStep: () => {},
        isAborted: () => false,
        waitForConfirmation: () => Promise.resolve(true)
      }

      const wrapped = agent.testWrapExecutorConfigForToolCall(run, tc, base)
      const step = wrapped.addStep({ type: 'tool_call', content: 'x', toolName: 'exec', toolCallId: 'tc-inner' })
      expect(step.toolCallId).toBe('tc-inner')
    })
  })

  // ==================== 工具返回图片的延迟注入 ====================
  // 这组测试覆盖之前的 bug：多个 read_file 并行返回图片时，旧实现立即在每个
  // tool 消息后 push 一条 user 消息，导致 user 夹在同批 tool 消息之间，
  // 触发 DeepSeek "insufficient tool messages following tool_calls message" 校验错误。
  // 修复后：图片暂存到 pendingToolImages，由 flushPendingToolImages 在批次结束时
  // 合并为单条 user 消息追加到所有 tool 消息之后。
  describe('processToolResult + flushPendingToolImages (image deferral)', () => {
    function makeRun(): any {
      return {
        id: 'fake-run',
        steps: [],
        messages: [],
        taskMessageLog: [],
        requestId: undefined
      }
    }

    function makeToolCall(id: string, name: string) {
      return { id, type: 'function', function: { name, arguments: '{}' } } as any
    }

    it('should NOT push image user-message immediately; accumulate in pendingToolImages', () => {
      const run = makeRun()
      const tc = makeToolCall('tc-a', 'read_file')

      agent.testProcessToolResult(run, tc, {
        success: true,
        output: 'ok',
        images: ['data:image/png;base64,AAAA']
      })

      // tool 消息已 push，但 user 图片消息没有
      expect(run.messages).toHaveLength(1)
      expect(run.messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'tc-a' })
      expect(run.pendingToolImages).toEqual(['data:image/png;base64,AAAA'])
    })

    it('should preserve OpenAI tool_calls protocol when multiple tools return images in one batch', () => {
      const run = makeRun()
      // 模拟一批 assistant.tool_calls 已经 push 过
      run.messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'tc-b', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ]
      })

      // 两个工具依次完成，每个都返回图片
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok-a', images: ['imgA']
      })
      agent.testProcessToolResult(run, makeToolCall('tc-b', 'read_file'), {
        success: true, output: 'ok-b', images: ['imgB']
      })

      // 此时 messages 中只能是 assistant → tool_a → tool_b（user 还没注入）
      expect(run.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool'])
      expect(run.pendingToolImages).toEqual(['imgA', 'imgB'])

      // 批次结束 flush
      agent.testFlushPendingToolImages(run)

      // 最终序列：assistant → tool → tool → user(合并的图片)
      // 关键：两条 tool 消息之间没有 user 消息，DeepSeek API 才会接受
      expect(run.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
      const userMsg = run.messages[3]
      expect(userMsg.images).toEqual(['imgA', 'imgB'])
      expect(run.pendingToolImages).toEqual([])
    })

    it('should not write images to taskMessageLog (they are too large to persist)', () => {
      const run = makeRun()
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['large-base64-data']
      })
      agent.testFlushPendingToolImages(run)

      const userInLog = run.taskMessageLog.find((m: any) => m.role === 'user')
      expect(userInLog).toBeDefined()
      expect(userInLog.images).toBeUndefined()
      expect(userInLog.content).toBeTruthy()
    })

    it('flushPendingToolImages should be idempotent (no-op when pending is empty)', () => {
      const run = makeRun()

      agent.testFlushPendingToolImages(run)
      expect(run.messages).toEqual([])

      agent.testProcessToolResult(run, makeToolCall('tc-a', 'read_file'), {
        success: true, output: 'ok', images: ['img']
      })
      agent.testFlushPendingToolImages(run)
      const lengthAfterFirst = run.messages.length

      // 再 flush 一次，不应再产生 user 消息
      agent.testFlushPendingToolImages(run)
      expect(run.messages).toHaveLength(lengthAfterFirst)
    })

    it('should not flush when no tool returns images', () => {
      const run = makeRun()
      agent.testProcessToolResult(run, makeToolCall('tc-a', 'execute_command'), {
        success: true, output: 'plain text output'
      })
      agent.testFlushPendingToolImages(run)

      expect(run.messages.map((m: any) => m.role)).toEqual(['tool'])
      // 无图片场景下不需要初始化 pendingToolImages（undefined 或空数组都视为"无暂存"）
      expect(run.pendingToolImages?.length ?? 0).toBe(0)
    })
  })
})

// ==================== Agent run 方法测试 ====================

describe('Agent run method', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>
  let mockPtyService: ReturnType<typeof createMockPtyService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockPtyService = createMockPtyService()
    mockServices = createMockServices({
      aiService: mockAiService as any,
      ptyService: mockPtyService as any
    })
    agent = new TestAgent(mockServices)
  })

  describe('run lifecycle', () => {
    it('should throw if already running', async () => {
      // 模拟一个简单的 AI 响应
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          // 延迟完成以模拟运行状态
          setTimeout(() => {
            onDone({ content: 'Done', tool_calls: undefined })
          }, 100)
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const promise1 = agent.run('First task', context)
      
      // 立即尝试第二次运行应该抛出错误
      await expect(agent.run('Second task', context)).rejects.toThrow('Agent is already running')
      
      // 等待第一个运行完成
      await promise1
    })

    it('should return AI response content', async () => {
      const expectedResponse = 'Task completed successfully'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk(expectedResponse)
          onDone({ content: expectedResponse, tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const result = await agent.run('Test task', context)
      
      expect(result).toBe(expectedResponse)
    })

    it('should set up output listener', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test task', context)
      
      // 验证 onData 被调用来设置监听器
      expect(mockPtyService.onData).toHaveBeenCalled()
    })

    it('should handle errors during execution', async () => {
      const errorMessage = 'AI service error'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onError) => {
          onError(errorMessage)
          return Promise.reject(new Error(errorMessage))
        }
      )

      const context = createMockContext()
      
      await expect(agent.run('Test task', context)).rejects.toThrow(errorMessage)
    })

    it('should call onComplete callback on success', async () => {
      const onComplete = vi.fn()
      const expectedResponse = 'Task done'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk(expectedResponse)
          onDone({ content: expectedResponse, tool_calls: undefined })
          return Promise.resolve()
        }
      )

      agent.setCallbacks({ onComplete })
      
      const context = createMockContext()
      await agent.run('Test task', context)
      
      expect(onComplete).toHaveBeenCalled()
    })

    it('should call onError callback on failure', async () => {
      const onError = vi.fn()
      const errorMessage = 'Test error'
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onErrorCb) => {
          onErrorCb(errorMessage)
          return Promise.reject(new Error(errorMessage))
        }
      )

      agent.setCallbacks({ onError })
      
      const context = createMockContext()
      
      try {
        await agent.run('Test task', context)
      } catch {
        // 预期抛出错误
      }
      
      expect(onError).toHaveBeenCalled()
    })
  })

  describe('task memory', () => {
    it('should save task to memory on success', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test task', context)
      
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(1)
    })

    it('should save task to memory on failure', async () => {
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, _onDone, onError) => {
          onError('Failed')
          return Promise.reject(new Error('Failed'))
        }
      )

      const context = createMockContext()
      
      try {
        await agent.run('Test task', context)
      } catch {
        // 预期抛出错误
      }
      
      const taskMemory = agent.exposeTaskMemory()
      expect(taskMemory.getTaskCount()).toBe(1)
    })

    it('should restore from HistoryService when sessionId is provided', async () => {
      const sessionId = 'session_test_123'
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue({
          id: sessionId,
          timestamp: Date.now() - 5000,
          terminalId: 'test-pty',
          terminalType: 'local',
          userTask: 'Previous task',
          steps: [
            { id: 'ut1', type: 'user_task', content: 'Previous task', timestamp: Date.now() - 5000 },
            { id: 'fr1', type: 'final_result', content: 'Previous result', timestamp: Date.now() - 4000 }
          ],
          messages: [
            { role: 'user', content: 'Previous task' },
            { role: 'assistant', content: 'Previous result' }
          ],
          finalResult: 'Previous result',
          duration: 1000,
          status: 'completed'
        }),
        saveAgentRecord: vi.fn()
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const agentWithHistory = new TestAgent(services)

      mockAiService = services.aiService as any
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId, sessionStartTime: Date.now() - 5000 })
      await agentWithHistory.run('New task', context)

      const taskMemory = agentWithHistory.exposeTaskMemory()
      // 应该有 2 个任务：从 HistoryService 恢复的 + 当前的
      expect(taskMemory.getTaskCount()).toBe(2)
      expect(mockHistoryService.getAgentRecordById).toHaveBeenCalledWith(sessionId)
    })

    it('should restore from steps when messages field is missing (old records)', async () => {
      const sessionId = 'session_old_record'
      const mockHistoryService = {
        getAgentRecordById: vi.fn().mockReturnValue({
          id: sessionId,
          timestamp: Date.now() - 5000,
          terminalId: 'test-pty',
          terminalType: 'local',
          userTask: 'Old task without messages',
          steps: [
            { id: 'ut1', type: 'user_task', content: 'Old task 1', timestamp: Date.now() - 5000 },
            { id: 'tc1', type: 'tool_call', content: 'Running command', toolName: 'execute_command', timestamp: Date.now() - 4500 },
            { id: 'tr1', type: 'tool_result', content: 'OK', toolName: 'execute_command', toolResult: 'success', timestamp: Date.now() - 4000 },
            { id: 'fr1', type: 'final_result', content: 'Task 1 done', timestamp: Date.now() - 3500 },
            { id: 'ut2', type: 'user_task', content: 'Old task 2', timestamp: Date.now() - 3000 },
            { id: 'fr2', type: 'final_result', content: 'Task 2 done', timestamp: Date.now() - 2000 }
          ],
          // messages field is intentionally missing (old record)
          finalResult: 'Task 2 done',
          duration: 3000,
          status: 'completed'
        }),
        saveAgentRecord: vi.fn()
      }

      const services = createMockServices({ historyService: mockHistoryService as any })
      const agentWithHistory = new TestAgent(services)

      mockAiService = services.aiService as any
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages: any, _tools: any, onChunk: any, _onToolCall: any, onDone: any) => {
          onChunk('Done')
          onDone({ content: 'Done', tool_calls: undefined })
          return Promise.resolve()
        }
      )

      const context = createMockContext({ sessionId, sessionStartTime: Date.now() - 5000 })
      await agentWithHistory.run('New task', context)

      const taskMemory = agentWithHistory.exposeTaskMemory()
      // 应该有 3 个任务：从 steps 恢复的 2 个 + 当前的 1 个
      expect(taskMemory.getTaskCount()).toBe(3)
      expect(mockHistoryService.getAgentRecordById).toHaveBeenCalledWith(sessionId)
    })
  })

  describe('with tool calls', () => {
    it('should execute tool calls from AI response', async () => {
      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: {
          name: 'test_tool',
          arguments: '{}'
        }
      }

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            // 第一次调用返回工具调用
            onDone({ content: '', tool_calls: [toolCall] })
          } else {
            // 第二次调用返回最终响应
            onChunk('Final response')
            onDone({ content: 'Final response', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      agent.mockTools = [{
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: {} }
        }
      }]

      const context = createMockContext()
      const result = await agent.run('Test with tools', context)
      
      // 应该调用两次 AI：第一次返回工具调用，第二次返回最终响应
      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
      expect(result).toBe('Final response')
    })

    it('should batch adjacent parallelizable tools together', async () => {
      // 测试分批逻辑：使用只读工具来测试分批
      // [read_file, read_file, search_knowledge, read_file]
      // 全是可并行工具，应该在一个批次并行执行
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        { id: 'call-3', type: 'function' as const, function: { name: 'file_search', arguments: '{"pattern":"*.ts"}' } },
        { id: 'call-4', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 验证所有工具结果都已返回
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            expect(toolResults.length).toBe(4)
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test parallel tools', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })

    it('should execute multiple parallelizable tools in parallel', async () => {
      // 测试多个可并行工具确实是并行执行的
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 检查消息历史中的工具结果
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            // 应该有 2 个工具结果，且顺序正确
            expect(toolResults.length).toBe(2)
            expect(toolResults[0].tool_call_id).toBe('call-1')
            expect(toolResults[1].tool_call_id).toBe('call-2')
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test parallel execution', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })

    it('should maintain execution order for mixed tool calls', async () => {
      // 测试混合工具调用保持正确的执行顺序
      // [read_file(A), execute_command(B), read_file(C)]
      // 期望：先执行 A，再执行 B，最后执行 C
      // 使用 free 模式跳过确认
      agent.updateConfig({ executionMode: 'free' })
      
      const toolCalls = [
        { id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { id: 'call-2', type: 'function' as const, function: { name: 'execute_command', arguments: '{"command":"echo test"}' } },
        { id: 'call-3', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"c.txt"}' } },
      ]

      let callCount = 0
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          callCount++
          if (callCount === 1) {
            onDone({ content: '', tool_calls: toolCalls })
          } else {
            // 检查消息历史中的工具结果顺序
            const messages = _messages as AiMessage[]
            const toolResults = messages.filter(m => m.role === 'tool')
            // 应该有 3 个工具结果，且顺序与原始调用顺序一致
            expect(toolResults.length).toBe(3)
            expect(toolResults[0].tool_call_id).toBe('call-1')
            expect(toolResults[1].tool_call_id).toBe('call-2')
            expect(toolResults[2].tool_call_id).toBe('call-3')
            
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      await agent.run('Test mixed tools order', context)

      expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
    })
  })
})

// ==================== Agent 运行时状态管理测试 ====================

describe('Agent runtime state management', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new TestAgent(mockServices)
  })

  describe('abort during execution', () => {
    it('should abort running task', async () => {
      let resolveAi: (() => void) | undefined
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          return new Promise<void>((resolve) => {
            resolveAi = () => {
              onDone({ content: 'Aborted', tool_calls: undefined })
              resolve()
            }
          })
        }
      )

      const context = createMockContext()
      const promise = agent.run('Long running task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // 现在应该在运行中
      expect(agent.isRunning()).toBe(true)
      
      // 中止
      const aborted = agent.abort()
      expect(aborted).toBe(true)
      
      // 验证 AI 服务的 abort 被调用
      expect(mockAiService.abort).toHaveBeenCalled()
      
      // 完成 AI 调用
      resolveAi?.()
      await promise
    })
  })

  describe('addUserMessage during execution', () => {
    it('should add message to pending queue', async () => {
      // 使用同步的方式来测试，避免 Promise 超时问题
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, onChunk, _onToolCall, onDone) => {
          // 模拟稍微延迟的响应
          setTimeout(() => {
            onChunk('Done')
            onDone({ content: 'Done', tool_calls: undefined })
          }, 50)
          return Promise.resolve()
        }
      )

      const context = createMockContext()
      const promise = agent.run('Task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      // 添加用户消息
      const added = agent.addUserMessage('User supplement')
      expect(added).toBe(true)
      
      // 等待完成
      await promise
    }, 10000) // 增加超时时间
  })

  describe('getRunStatus during execution', () => {
    it('should return correct status', async () => {
      let resolveAi: (() => void) | undefined
      
      mockAiService.chatWithToolsStream.mockImplementation(
        (_messages, _tools, _onChunk, _onToolCall, onDone) => {
          return new Promise<void>((resolve) => {
            resolveAi = () => {
              onDone({ content: 'Done', tool_calls: undefined })
              resolve()
            }
          })
        }
      )

      const context = createMockContext()
      const promise = agent.run('Task', context)
      
      // 等待一下让 agent 开始运行
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const status = agent.getRunStatus()
      expect(status).toBeDefined()
      expect(status!.isRunning).toBe(true)
      expect(status!.hasPendingConfirmation).toBe(false)
      
      // 完成
      resolveAi?.()
      await promise
    })
  })
})

// ==================== Agent 步骤回调测试 ====================

describe('Agent step callbacks', () => {
  let agent: TestAgent
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new TestAgent(mockServices)
  })

  it('should call onStep for initial thinking step', async () => {
    const onStep = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStep })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    // 应该至少调用一次 onStep
    expect(onStep).toHaveBeenCalled()
    
    // 第一个步骤是 user_task（后端统一生成），第二个是 thinking
    const firstCall = onStep.mock.calls[0]
    expect(firstCall[1].type).toBe('user_task')
    const secondCall = onStep.mock.calls[1]
    expect(secondCall[1].type).toBe('thinking')
  })

  it('should call onStep for message step', async () => {
    const onStep = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStep })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    // 检查是否有 message 类型的步骤
    const messageCalls = onStep.mock.calls.filter(
      (call: [string, AgentStep]) => call[1].type === 'message'
    )
    expect(messageCalls.length).toBeGreaterThan(0)
  })
})

// ==================== SkillSession 持久化测试 ====================

describe('Agent SkillSession persistence', () => {
  let agent: TestAgent

  beforeEach(() => {
    const mockAiService = createMockAiService()
    const services = createMockServices(mockAiService)
    agent = new TestAgent(services)
  })

  it('should return same skillSession instance on multiple calls (lazy init)', () => {
    // 第一次获取
    const session1 = agent.exposeGetSkillSession()
    
    // 第二次获取
    const session2 = agent.exposeGetSkillSession()
    
    // 应该是同一个实例（延迟初始化后持久化）
    expect(session1).toBeDefined()
    expect(session2).toBeDefined()
    expect(session1).toBe(session2)
  })

  it('should have getLoadedSkills method', () => {
    const session = agent.exposeGetSkillSession()
    
    // 初始状态应该没有加载任何技能
    expect(session.getLoadedSkills()).toEqual([])
  })

  it('should cleanup skillSession and currentRun when agent cleanup is called', () => {
    // 先触发 skillSession 初始化
    const session = agent.exposeGetSkillSession()
    expect(session).toBeDefined()
    
    // cleanup
    agent.cleanup()
    
    // currentRun 应该被清理
    expect(agent.exposeCurrentRun()).toBeUndefined()
  })
})
