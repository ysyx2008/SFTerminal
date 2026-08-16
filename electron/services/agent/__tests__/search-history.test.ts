import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../knowledge', () => ({
  getKnowledgeService: vi.fn(),
}))

import { getKnowledgeService } from '../../knowledge'
import { searchHistory } from '../tools/memory'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(overrides: Partial<ToolExecutorConfig> = {}): ToolExecutorConfig {
  return {
    isAborted: () => false,
    addStep: vi.fn(),
    getHostId: () => 'personal',
    getAbortSignal: () => undefined,
    ...overrides,
  } as unknown as ToolExecutorConfig
}

describe('searchHistory semantic detail=full', () => {
  const searchConversations = vi.fn()
  const getAgentRecordById = vi.fn()
  const searchAgentRecordsAdvanced = vi.fn()

  beforeEach(() => {
    searchConversations.mockReset()
    getAgentRecordById.mockReset()
    searchAgentRecordsAdvanced.mockReset()
    vi.mocked(getKnowledgeService).mockReturnValue({
      isEnabled: () => true,
      searchConversations,
    } as unknown as ReturnType<typeof getKnowledgeService>)
  })

  it('按 taskId 定点取记录，不走全文关键词扫描', async () => {
    searchConversations.mockResolvedValue([{
      taskId: 'sess_abc',
      userRequest: '写论文',
      finalResult: 'ok',
      status: 'success',
      timestamp: 1,
      relevance: 0.9,
    }])
    getAgentRecordById.mockReturnValue({
      id: 'sess_abc',
      steps: [
        { type: 'tool_call', toolName: 'read_file', toolArgs: { path: '/tmp/a' } },
      ],
    })

    const executor = makeExecutor({
      historyService: { getAgentRecordById, searchAgentRecordsAdvanced } as unknown as ToolExecutorConfig['historyService'],
    })

    const result = await searchHistory(
      { mode: 'semantic', keyword: '论文', detail: 'full' },
      executor
    )

    expect(getAgentRecordById).toHaveBeenCalledWith('sess_abc', { omitCanvasData: true })
    expect(searchAgentRecordsAdvanced).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.output).toContain('read_file')
    expect(result.output).toContain('写论文')
  })

  it('taskId 对不上时不抛错，只给摘要', async () => {
    searchConversations.mockResolvedValue([{
      taskId: 'already-deleted',
      userRequest: '写论文',
      finalResult: 'ok',
      status: 'success',
      timestamp: 1,
      relevance: 0.8,
    }])
    getAgentRecordById.mockReturnValue(undefined)

    const executor = makeExecutor({
      historyService: { getAgentRecordById, searchAgentRecordsAdvanced } as unknown as ToolExecutorConfig['historyService'],
    })

    const result = await searchHistory(
      { mode: 'semantic', keyword: '论文', detail: 'full' },
      executor
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('写论文')
    expect(result.output).not.toContain('**工具调用**')
  })
})
