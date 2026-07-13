/**
 * 任务侧栏短标题生成单测
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sanitizeConversationTitle,
  generateConversationTitle,
  resetTitleGeneratorInflightForTest,
} from '../title-generator'
import type { AiService } from '../../ai.service'
import type { ConfigService } from '../../config.service'
import type { HistoryService } from '../../history.service'
import type { AgentService } from '../../agent/index'

vi.mock('../../agent/skills/config/executor', () => ({
  notifyFrontendConfigChanged: vi.fn(),
}))

describe('sanitizeConversationTitle', () => {
  it('去掉首尾引号与空白，只取首行', () => {
    expect(sanitizeConversationTitle('  "修复登录重定向"  \n多余一行')).toBe('修复登录重定向')
    expect(sanitizeConversationTitle("「Fix auth」")).toBe('Fix auth')
  })

  it('超长截断到 40 字符', () => {
    const long = '一'.repeat(50)
    expect(sanitizeConversationTitle(long)?.length).toBe(40)
  })

  it('空串返回 null', () => {
    expect(sanitizeConversationTitle('')).toBeNull()
    expect(sanitizeConversationTitle('   ')).toBeNull()
    expect(sanitizeConversationTitle('""')).toBeNull()
  })
})

describe('generateConversationTitle', () => {
  beforeEach(() => {
    resetTitleGeneratorInflightForTest()
    vi.clearAllMocks()
  })

  function makeDeps(opts?: {
    existingTitle?: string
    chatResult?: string
    chatError?: Error
  }) {
    let recordTitle = opts?.existingTitle
    const historyService = {
      getAgentRecordById: vi.fn((sessionId: string) =>
        recordTitle ? { id: sessionId, title: recordTitle } : undefined
      ),
    } as unknown as HistoryService

    const agentService = {
      setConversationTitleBySessionId: vi.fn((sessionId: string, title: string) => {
        recordTitle = title
        return true
      }),
    } as unknown as AgentService

    const configService = {
      getLanguage: vi.fn(() => 'zh-CN' as const),
    } as unknown as ConfigService

    const aiService = {
      chat: vi.fn(async () => {
        if (opts?.chatError) throw opts.chatError
        return opts?.chatResult ?? '修复登录重定向'
      }),
    } as unknown as AiService

    return {
      configService,
      aiService,
      historyService,
      agentService,
      getRecordTitle: () => recordTitle,
    }
  }

  it('成功生成并写入会话 title', async () => {
    const deps = makeDeps()
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '帮我看看登录为什么总跳错页',
    })
    expect(title).toBe('修复登录重定向')
    expect(deps.agentService.setConversationTitleBySessionId).toHaveBeenCalledWith(
      'session_1',
      '修复登录重定向'
    )
  })

  it('已有自定义标题则跳过且不调 LLM', async () => {
    const deps = makeDeps({ existingTitle: '我改的名字' })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '随便',
    })
    expect(title).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
  })

  it('系统占位消息跳过', async () => {
    const deps = makeDeps()
    expect(
      await generateConversationTitle(deps, {
        sessionId: 'session_1',
        userMessage: '__onboarding__',
      })
    ).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
  })

  it('LLM 失败时静默返回 null', async () => {
    const deps = makeDeps({ chatError: new Error('network') })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '测一下',
    })
    expect(title).toBeNull()
    expect(deps.agentService.setConversationTitleBySessionId).not.toHaveBeenCalled()
  })

  it('生成期间用户已手动改名则不覆盖', async () => {
    const deps = makeDeps()
    ;(deps.aiService.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // 模拟 LLM 等待期间用户改名
      deps.agentService.setConversationTitleBySessionId('session_1', '手动标题')
      return '模型标题'
    })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '测一下',
    })
    expect(title).toBeNull()
    expect(deps.getRecordTitle()).toBe('手动标题')
  })
})
