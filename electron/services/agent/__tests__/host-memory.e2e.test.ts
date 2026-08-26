/**
 * 助手主机记忆：真实 Agent.run + 真落盘 + 脚本化模型。
 * 验收的是「写到哪、读到什么」，不是函数返回值。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition, ToolDefinitionWithMeta } from '../tools'
import type { AgentContext, AgentServices, PromptOptions } from '../types'
import { ptyExecuteCommandTool, terminalOnlyTools } from '../skills/terminal/tools'

let tmpDir = ''
let ck: import('../../knowledge/context-knowledge').ContextKnowledgeService

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir || os.tmpdir(),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null),
}))

vi.mock('../../knowledge', () => ({
  getKnowledgeService: () => ({
    isEnabled: () => false,
    searchConversations: async () => [],
    buildContext: async () => '',
    indexConversation: async () => {},
  }),
}))

vi.mock('../../knowledge/context-knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../knowledge/context-knowledge')>()
  return {
    ...actual,
    getContextKnowledgeService: () => ck,
  }
})

import { Agent } from '../agent'
import { ContextKnowledgeService } from '../../knowledge/context-knowledge'
import type { ToolCall } from '../../ai.service'

const sendInputTool = terminalOnlyTools.find(t => t.function.name === 'send_input') as ToolDefinitionWithMeta
const openWindowStub: ToolDefinitionWithMeta = {
  type: 'function',
  function: {
    name: 'open_window',
    description: '开窗，不算对主机动手',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
  },
}

class MemoryAgent extends Agent {
  mockTools: ToolDefinition[] = [ptyExecuteCommandTool, sendInputTool, openWindowStub]
  lastSystemPrompt = ''

  getAvailableTools(): ToolDefinition[] {
    return this.mockTools
  }

  protected buildSystemPrompt(_context: AgentContext, options: PromptOptions): string {
    this.lastSystemPrompt = `# 已知信息\n\n${options.contextKnowledgeDoc || ''}`
    return this.lastSystemPrompt
  }

  updateKnowledge(run: unknown, result?: string) {
    return (this as unknown as { updateContextKnowledgeAsync: (r: unknown, s?: string) => Promise<void> })
      .updateContextKnowledgeAsync(run, result)
  }

  wrapExecutor(run: unknown, toolCall: ToolCall) {
    const base = (this as any).createToolExecutorConfig(run)
    return (this as any).wrapExecutorConfigForToolCall(run, toolCall, base)
  }
}

type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

function tc(name: string, args: Record<string, unknown>, id: string): NonNullable<LlmResponse['tool_calls']>[0] {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function knowledgeReply(messages: Array<{ role?: string; content?: unknown }>): string {
  const prompt = String(messages[0]?.content || '')
  if (prompt.includes('root@prod')) return '## prod\nnginx 监听 8080\n'
  if (prompt.includes('ubuntu@box')) return '## box\npython 3.12\n'
  if (prompt.includes('本机这条连接') || prompt.includes('本地主机')) return '## 本机\n本机是 macOS\n'
  if (prompt.includes('个人')) return '## 个人\n用户喜欢简洁\n'
  return 'NO_CHANGE'
}

function makeServices(script: (callIndex: number, messages: unknown[]) => LlmResponse): {
  services: AgentServices
  chat: ReturnType<typeof vi.fn>
} {
  let callIndex = 0
  const chat = vi.fn(async (messages: Array<{ role?: string; content?: unknown }>) => knowledgeReply(messages))
  const services: AgentServices = {
    aiService: {
      chat,
      chatWithToolsStream: vi.fn(async (
        messages: unknown[],
        _tools: unknown,
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
      ) => {
        const r = script(callIndex++, messages)
        if (r.content) onChunk(r.content)
        onDone({ content: r.content ?? '', tool_calls: r.tool_calls })
      }),
      abort: vi.fn(),
    } as any,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn(), getTerminalType: () => 'local' } as any,
    configService: {
      get: vi.fn().mockReturnValue(undefined),
      getAgentMbti: vi.fn().mockReturnValue(null),
      getAiRules: vi.fn().mockReturnValue(''),
      getAgentPersonalityText: vi.fn().mockReturnValue(''),
      getAgentName: vi.fn().mockReturnValue(''),
      getLanguage: vi.fn().mockReturnValue('zh-CN'),
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true),
      getCommandRiskPolicy: vi.fn().mockReturnValue(undefined),
    } as any,
    unifiedTerminalService: {
      getTerminalType: (id: string) => {
        if (id === 'pty-prod' || id === 'pty-box') return 'ssh'
        if (id === 'pty-local') return 'local'
        return null
      },
      write: () => { throw new Error('e2e: no live tty') },
      hasInstance: () => false,
      onData: vi.fn().mockReturnValue(() => {}),
    } as any,
    sshService: {
      getConfig: (id: string) => {
        if (id === 'pty-prod') return { username: 'root', host: 'prod' }
        if (id === 'pty-box') return { username: 'ubuntu', host: 'box' }
        return null
      },
    } as any,
  }
  return { services, chat }
}

function assistantCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    hostId: 'local',
    ...overrides,
  }
}

function docsOnDisk(): Record<string, string> {
  const dir = path.join(tmpDir, 'knowledge', 'context-docs')
  if (!fs.existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    out[file.replace(/\.md$/, '')] = fs.readFileSync(path.join(dir, file), 'utf-8')
  }
  return out
}

async function waitForDocs(pred: (docs: Record<string, string>) => boolean, timeoutMs = 3000) {
  const start = Date.now()
  let last = docsOnDisk()
  while (Date.now() - start < timeoutMs) {
    last = docsOnDisk()
    if (pred(last)) return last
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`知识文档未在 ${timeoutMs}ms 内落到预期状态: ${JSON.stringify(last)}`)
}

describe('助手主机记忆端到端', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-host-mem-e2e-'))
    ck = new ContextKnowledgeService()
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('只聊天：只写个人，本机和远程都不动', async () => {
    const { services, chat } = makeServices(() => ({ content: '好的，记住了，以后简洁回复' }))
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('以后请简洁一点', assistantCtx())
    const docs = await waitForDocs(d => Boolean(d.personal))

    expect(docs.personal).toContain('用户喜欢简洁')
    expect(docs.local).toBeUndefined()
    expect(docs['root@prod']).toBeUndefined()
    expect(chat.mock.calls.length).toBe(1)
    expect(String(chat.mock.calls[0][0][0].content)).toContain('个人')
  })

  it('前端误传 hostId=local 的助手，仍然只写个人', async () => {
    const { services } = makeServices(() => ({ content: '记下了' }))
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })
    await agent.run('记住我喜欢简洁', assistantCtx({ hostId: 'local' }))
    const docs = await waitForDocs(d => Boolean(d.personal))
    expect(docs.local).toBeUndefined()
    expect(docs.personal).toBeTruthy()
  })

  it('对远程 A 动手：个人 + A，不动 B', async () => {
    let turn = 0
    const { services } = makeServices(() => {
      if (turn++ === 0) {
        return { content: '', tool_calls: [tc('send_input', { text: 'y', pane_id: 'pty-prod' }, 'call-a')] }
      }
      return { content: '已在 prod 确认' }
    })
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('在 prod 上确认一下', assistantCtx({ ptyId: 'pty-prod' }))
    const docs = await waitForDocs(d => Boolean(d.personal) && Boolean(d['root@prod']))

    expect(docs.personal).toContain('用户喜欢简洁')
    expect(docs['root@prod']).toContain('nginx 监听 8080')
    expect(docs['ubuntu@box']).toBeUndefined()
    expect(docs.local).toBeUndefined()
  })

  it('一场动 A 和 B：各写各的', async () => {
    let turn = 0
    const { services } = makeServices(() => {
      if (turn++ === 0) {
        return {
          content: '',
          tool_calls: [
            tc('send_input', { text: 'y', pane_id: 'pty-prod' }, 'call-a'),
            tc('send_input', { text: 'n', pane_id: 'pty-box' }, 'call-b'),
          ],
        }
      }
      return { content: '两台都问过了' }
    })
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('分别问两台', assistantCtx())
    const docs = await waitForDocs(d => Boolean(d['root@prod']) && Boolean(d['ubuntu@box']) && Boolean(d.personal))

    expect(docs['root@prod']).toContain('nginx 监听 8080')
    expect(docs['ubuntu@box']).toContain('python 3.12')
    expect(docs.personal).toBeTruthy()
    expect(docs.local).toBeUndefined()
  })

  it('只开窗、没动手：不写那台', async () => {
    let turn = 0
    const { services } = makeServices(() => {
      if (turn++ === 0) {
        return { content: '', tool_calls: [tc('open_window', { action: 'open' }, 'call-open')] }
      }
      return { content: '窗开好了' }
    })
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('开一扇远程窗', assistantCtx({ ptyId: 'pty-prod' }))
    const docs = await waitForDocs(d => Boolean(d.personal))

    expect(docs['root@prod']).toBeUndefined()
    expect(docs.local).toBeUndefined()
    expect(docs.personal).toBeTruthy()
  })

  it('已开着的窗，冷启动能看见那台已有记忆', async () => {
    ck.setDocument('root@prod', '已有事实：磁盘是 nvme')
    ck.setDocument('personal', '用户叫小鱼')
    const { services } = makeServices(() => ({ content: '我看见了' }))
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('这台磁盘怎么样', assistantCtx({
      ptyId: 'pty-prod',
      panes: [{
        paneId: 'p1',
        ptyId: 'pty-prod',
        label: '左侧',
        isActive: true,
        terminalOutput: [],
        terminalType: 'ssh',
      }],
    }))

    expect(agent.lastSystemPrompt).toContain('用户叫小鱼')
    expect(agent.lastSystemPrompt).toContain('已有事实：磁盘是 nvme')
  })

  it('接着聊走缓存，不为新开的台打断前缀', async () => {
    ck.setDocument('personal', '用户叫小鱼')
    const { services } = makeServices(() => ({ content: '嗯' }))
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('你好', assistantCtx())
    const firstPrompt = agent.lastSystemPrompt
    expect(firstPrompt).toContain('用户叫小鱼')
    expect(firstPrompt).not.toContain('磁盘是 nvme')

    ck.setDocument('root@prod', '已有事实：磁盘是 nvme')
    await agent.run('再问一句', assistantCtx({
      ptyId: 'pty-prod',
      panes: [{
        paneId: 'p1',
        ptyId: 'pty-prod',
        label: '左侧',
        isActive: true,
        terminalOutput: [],
        terminalType: 'ssh',
      }],
    }))

    expect(agent.lastSystemPrompt).toBe(firstPrompt)
    expect(agent.lastSystemPrompt).not.toContain('磁盘是 nvme')
  })

  it('本机终端页动手：写 local，不写个人', async () => {
    let turn = 0
    const { services } = makeServices(() => {
      if (turn++ === 0) {
        return { content: '', tool_calls: [tc('send_input', { text: 'ls', pane_id: 'pty-local' }, 'call-l')] }
      }
      return { content: '列完了' }
    })
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    await agent.run('列一下文件', {
      ptyId: 'pty-local',
      terminalOutput: [],
      systemInfo: { os: 'darwin', shell: '/bin/zsh' },
      terminalType: 'local',
      hostId: 'local',
    })
    const docs = await waitForDocs(d => Boolean(d.local))

    expect(docs.local).toContain('本机是 macOS')
    expect(docs.personal).toBeUndefined()
  })

  it('直接走执行器：动手记账后收工，磁盘上只有该台', async () => {
    const { services } = makeServices(() => ({ content: 'x' }))
    const agent = new MemoryAgent(services)
    agent.updateConfig({ executionMode: 'free' })

    const run = {
      id: 'run-direct',
      originalUserRequest: '在 prod 敲一下',
      messages: [],
      steps: [] as Array<{ type: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; toolCallId?: string }>,
      isRunning: true,
      aborted: false,
      pendingUserMessages: [],
      config: { executionMode: 'free', commandTimeout: 5000, debugMode: false },
      context: assistantCtx({ ptyId: 'pty-prod' }),
      realtimeOutputBuffer: [],
      executionPhase: 'executing_command',
      taskMessageLog: [],
      hostOperations: new Map<string, string>(),
      ptyId: 'pty-prod',
    }
    ;(agent as any).currentRun = run
    const { executeTool } = await import('../tools/index')
    const toolCall: ToolCall = {
      id: 'direct-a',
      type: 'function',
      function: { name: 'send_input', arguments: JSON.stringify({ text: 'y', pane_id: 'pty-prod' }) },
    }
    const executor = agent.wrapExecutor(run, toolCall)
    await executeTool('pty-prod', toolCall, run.config as any, [], executor)

    expect([...run.hostOperations.entries()]).toEqual([['direct-a', 'root@prod']])

    await agent.updateKnowledge(run, '已确认')
    const docs = docsOnDisk()
    expect(docs['root@prod']).toContain('nginx 监听 8080')
    expect(docs.personal).toContain('用户喜欢简洁')
    expect(docs.local).toBeUndefined()
    expect(docs['ubuntu@box']).toBeUndefined()
  })
})
