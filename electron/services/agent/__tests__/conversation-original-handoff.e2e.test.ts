/**
 * 同一场对话：原文 + 交接 的端到端装配。
 *
 * 不启 Electron。按生产顺序接 Conversation → 落盘 → 重开 → 装配，
 * 对上 SPEC「先带原文，窗口满了才交接」。
 */
import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Conversation } from '../../conversation/conversation'
import { buildRecentTasksContext } from '../context-builder'
import { ContextWindowManager, type ContextWindowDeps } from '../context-window'
import {
  writeAgentRecordFile,
  readAgentRecordFile,
  getAgentRecordPath
} from '../../history/agent-storage'
import type { AgentStep } from '../types'
import type { AiMessage } from '../../ai.service'
import type { AgentRun } from '../types'
import type { AiProfile } from '@shared/types'
import { vi } from 'vitest'

const WORD_PATH = '/Users/me/Desktop/周报.docx'
const WORD_BODY = '已写入周报到桌面文档，目录里还有对照表。'
const HUGE_TOOL = 'x'.repeat(8000)

const userStep = (content: string): AgentStep =>
  ({ id: `u_${content}`, type: 'user_task', content, timestamp: Date.now() } as AgentStep)
const finalStep = (content: string): AgentStep =>
  ({ id: `f_${content}`, type: 'final_result', content, timestamp: Date.now() } as AgentStep)

function commitTurn(
  conv: Conversation,
  runId: string,
  userRequest: string,
  runMessages: AiMessage[],
  result: string,
  extra?: { taskStatus?: 'success' | 'aborted'; imagesStripped?: boolean }
): void {
  const prev = conv.getCachePrefix() ?? []
  conv.commitRun({
    runId,
    userRequest,
    steps: [userStep(userRequest), finalStep(result)],
    taskMessageLog: runMessages.map(m => ({ ...m })),
    runMessages: [...prev, ...runMessages],
    taskStatus: extra?.taskStatus ?? 'success',
    result,
    imagesStripped: extra?.imagesStripped
  })
}

/** 重开后第一轮该带着什么：有交接用检查点，没有就从工作记忆装原文。 */
function assembleForResume(conv: Conversation, budget = 100_000): AiMessage[] {
  if (conv.hasHandoff() && conv.getCachePrefix()?.length) {
    return conv.prepareCachePrefix()
  }
  return buildRecentTasksContext(conv.taskMemory, budget).recentTaskMessages
}

function flatten(messages: AiMessage[]): string {
  return messages.map(m => {
    const args = m.tool_calls?.map(tc => `${tc.function.name} ${tc.function.arguments}`).join('\n') ?? ''
    return `${m.content}\n${args}`
  }).join('\n')
}

function writeWordConversation(): Conversation {
  const conv = Conversation.create(
    { agentKey: 'tab-word', terminalType: 'assistant' },
    { id: 'sess_word', createdAt: 1_700_000_000_000 }
  )
  commitTurn(conv, 'r1', '先看一眼目录', [
    { role: 'user', content: '先看一眼目录' },
    { role: 'assistant', content: '目录里有几份旧稿' }
  ], '目录里有几份旧稿')

  commitTurn(conv, 'r2', '写一份周报 Word', [
    { role: 'user', content: '写一份周报 Word' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'write_text_file', arguments: JSON.stringify({ path: WORD_PATH }) }
      }]
    },
    { role: 'tool', content: `${WORD_BODY}\n${HUGE_TOOL}`, tool_call_id: 'c1' },
    { role: 'assistant', content: '周报已经写到桌面那个 Word 里了' }
  ], '周报已经写到桌面那个 Word 里了')

  commitTurn(conv, 'r3', '再补一句结论', [
    { role: 'user', content: '再补一句结论' },
    { role: 'assistant', content: '结论已补上' }
  ], '结论已补上')

  return conv
}

function persistRoundTrip(conv: Conversation): Conversation {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-handoff-'))
  const record = conv.toRecord({ terminalId: 'pty-1' })
  if (!record) throw new Error('expected record')
  writeAgentRecordFile(dir, record)
  const dateStr = new Date(record.timestamp).toISOString().split('T')[0]
  const loaded = readAgentRecordFile(getAgentRecordPath(dir, dateStr, record.id))
  if (!loaded) throw new Error('expected loaded record')
  return Conversation.fromRecord(loaded)
}

describe('端到端：无检查点重开带着原文', () => {
  it('重开后能从原文对上前面写的 Word，过程也在', () => {
    const restored = persistRoundTrip(writeWordConversation())
    expect(restored.hasHandoff()).toBe(false)

    const assembled = assembleForResume(restored)
    const text = flatten(assembled)

    expect(text).toContain('写一份周报 Word')
    expect(text).toContain(WORD_PATH)
    expect(text).toContain(WORD_BODY)
    expect(text).toContain('周报已经写到桌面那个 Word 里了')
    expect(text).toContain('再补一句结论')
    expect(restored.toRecord({ terminalId: 'pty-1' })?.workingContext).toBeUndefined()
  })

  it('失败 / 中止 / 没有交代的轮次照实留，不编造成功收场', () => {
    const conv = Conversation.create({ agentKey: 'tab-edge', terminalType: 'assistant' })
    commitTurn(conv, 'ok', '写周报', [
      { role: 'user', content: '写周报' },
      { role: 'assistant', content: '周报已写到 weekly.docx' }
    ], '周报已写到 weekly.docx')
    conv.commitFailedRun({
      runId: 'fail',
      userRequest: '部署生产',
      steps: [userStep('部署生产'), finalStep('发布失败：缺权限')],
      taskLog: [
        { role: 'user', content: '部署生产' },
        { role: 'assistant', content: '发布失败：缺权限' }
      ],
      cachePrefix: [
        { role: 'user', content: '部署生产' },
        { role: 'assistant', content: '发布失败：缺权限' }
      ],
      errorMessage: '发布失败：缺权限'
    })

    const restored = persistRoundTrip(conv)
    const text = flatten(assembleForResume(restored))
    expect(text).toContain('写周报')
    expect(text).toContain('周报已写到 weekly.docx')
    expect(text).toContain('部署生产')
    expect(text).toContain('[任务执行失败]')
    expect(text).not.toMatch(/✓\s*success/)
  })

  it('原文超窗时留下近的完整原文，更早整轮可取回，不收成标题', () => {
    const conv = Conversation.create({ agentKey: 'tab-overflow', terminalType: 'assistant' })
    commitTurn(conv, 'old', '打开你前面写的那个很早的稿', [
      { role: 'user', content: '打开你前面写的那个很早的稿' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c-old',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/old.docx"}' }
        }]
      },
      { role: 'tool', content: 'y'.repeat(6000), tool_call_id: 'c-old' },
      { role: 'assistant', content: '旧稿在 /tmp/old.docx' }
    ], '旧稿在 /tmp/old.docx')
    commitTurn(conv, 'new', '现在改格式', [
      { role: 'user', content: '现在改格式' },
      { role: 'assistant', content: '格式改好了' }
    ], '格式改好了')

    const restored = persistRoundTrip(conv)
    const assembled = assembleForResume(restored, 180)
    const text = flatten(assembled)
    expect(text).toContain('现在改格式')
    expect(text).toContain('格式改好了')
    expect(text).not.toContain('y'.repeat(200))
    expect(buildRecentTasksContext(restored.taskMemory, 180).availableTaskIds.map(t => t.summary).join('\n'))
      .toMatch(/打开你前面写的那个很早的稿|旧稿/)
  })
})

describe('端到端：交接检查点重开不展开原文', () => {
  it('压过之后落盘再打开，接着检查点，巨大工具正文不回来', () => {
    const conv = writeWordConversation()
    const handoff: AiMessage[] = [
      { role: 'user', content: `[交接] 周报写在 ${WORD_PATH}，结论已补上。` },
      { role: 'user', content: '再补一句结论' },
      { role: 'assistant', content: '结论已补上' }
    ]
    conv.setWorkingContext(handoff)

    const restored = persistRoundTrip(conv)
    expect(restored.hasHandoff()).toBe(true)
    expect(restored.shouldReuseCachePrefix(1, { estimateTokens: () => 99999 })).toBe(true)
    expect(restored.shouldResumeWorkingPrefix({ skipVisionCache: true })).toBe(true)

    const assembled = assembleForResume(restored)
    const text = flatten(assembled)
    expect(text).toContain(WORD_PATH)
    expect(text).toContain('[交接]')
    expect(text).not.toContain(HUGE_TOOL)
    expect(text).not.toContain(WORD_BODY)

    const originals = flatten(buildRecentTasksContext(restored.taskMemory, 100_000).recentTaskMessages)
    expect(originals).toContain(HUGE_TOOL)
  })
})

describe('端到端：热路径窗口满了仍走已有交接', () => {
  it('主动压缩后检查点跟对话走，重开不再带压掉的工具正文', async () => {
    const conv = Conversation.create(
      { agentKey: 'tab-hot', terminalType: 'assistant' },
      { id: 'sess_hot', createdAt: 1_700_000_000_000 }
    )
    commitTurn(conv, 'seed', '写一份周报 Word', [
      { role: 'user', content: '写一份周报 Word' },
      { role: 'assistant', content: '开始写' }
    ], '开始写')

    const run = {
      id: 'compress',
      originalUserRequest: '写一份周报 Word',
      messages: [
        { role: 'user', content: '写一份周报 Word' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'c1',
            type: 'function',
            function: { name: 'write_text_file', arguments: JSON.stringify({ path: WORD_PATH }) }
          }]
        },
        { role: 'tool', content: `${WORD_BODY}\n${HUGE_TOOL}`, tool_call_id: 'c1' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c2', type: 'function', function: { name: 'exec', arguments: '{}' } }]
        },
        { role: 'tool', content: `输出 ${'D'.repeat(4000)}`, tool_call_id: 'c2' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c3', type: 'function', function: { name: 'exec', arguments: '{}' } }]
        },
        { role: 'tool', content: `输出 ${'E'.repeat(4000)}`, tool_call_id: 'c3' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c4', type: 'function', function: { name: 'exec', arguments: '{}' } }]
        },
        { role: 'tool', content: `输出 ${'F'.repeat(4000)}`, tool_call_id: 'c4' }
      ] as AiMessage[],
      steps: [],
      isRunning: false,
      aborted: false,
      pendingUserMessages: [],
      config: {} as AgentRun['config'],
      context: {} as AgentRun['context'],
      realtimeOutputBuffer: [],
      executionPhase: 'idle',
      taskMessageLog: []
    } as AgentRun

    expect(flatten(run.messages)).toContain(HUGE_TOOL)

    const deps: ContextWindowDeps = {
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 8000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getProfileId: () => undefined,
      getLastPromptTokens: () => 7600,
      getLastCacheHitRate: () => undefined,
      reportUsage: vi.fn(),
      invalidateTokenAnchor: () => conv.setLastPromptTokens(undefined),
      measureMessageRange: (from, to) => undefined,
      summarizeMessages: vi.fn().mockResolvedValue(`【交接】周报写在 ${WORD_PATH}。`),
      minProactiveRangeTokens: 200
    }
    const manager = new ContextWindowManager(deps)
    const compressed = await manager.proactiveCompress(run)
    expect(compressed).not.toBeNull()
    expect(flatten(run.messages)).not.toContain(HUGE_TOOL)
    conv.setWorkingContext(run.messages)

    const restored = persistRoundTrip(conv)
    const assembled = assembleForResume(restored)
    const text = flatten(assembled)
    expect(restored.hasHandoff()).toBe(true)
    expect(text).toContain(WORD_PATH)
    expect(text).not.toContain(HUGE_TOOL)
  })
})
