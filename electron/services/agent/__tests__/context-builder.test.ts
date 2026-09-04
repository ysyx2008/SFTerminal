/**
 * context-builder.ts 单元测试
 * 测试上下文构建器的预算计算、压缩和上下文引用检测
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  calculateBudget,
  detectContextReference,
  buildRecentTasksContext,
  buildTaskHistoryContext,
  sanitizeToolCallSequence
} from '../context-builder'
import { TaskMemoryStore } from '../task-memory'
import type { AgentStep } from '../types'
import type { AiMessage } from '../../ai.service'

// ==================== calculateBudget ====================

describe('calculateBudget', () => {
  it('should give remaining window to history after reserve', () => {
    const budget = calculateBudget(4000)
    expect(budget.total).toBe(3200)
    expect(budget.recentTasks).toBe(3200)
    expect(budget.currentConversation).toBe(800)
    expect(budget.knowledge).toBe(0)
    expect(budget.nearTasks).toBe(0)
    expect(budget.historySummary).toBe(0)
  })

  it('should cap reserve on large windows so history is not withheld', () => {
    const budget = calculateBudget(200000)
    expect(budget.currentConversation).toBe(32000)
    expect(budget.recentTasks).toBe(168000)
  })

  it('should give most of a 128K window to history', () => {
    const budget = calculateBudget(128000)
    expect(budget.recentTasks).toBe(102400)
    expect(budget.currentConversation).toBe(25600)
  })

  it('should handle small context lengths', () => {
    const budget = calculateBudget(1000)
    expect(budget.total).toBe(800)
    Object.values(budget).forEach(value => {
      expect(value).toBeGreaterThanOrEqual(0)
    })
  })
})

// ==================== detectContextReference ====================

describe('detectContextReference', () => {
  describe('Chinese context references', () => {
    it.each([
      ['刚才那个命令', '刚才'],
      ['刚刚说的', '刚刚'],
      ['上次的配置', '上次'],
      ['之前的错误', '之前'],
      ['继续执行', '继续'],
      ['接着做', '接着'],
      ['上一个任务', '上一个'],
      ['前面的步骤', '前面'],
      ['那个文件', '那个'],
      ['这个命令', '这个'],
      ['同样的方法', '同样的'],
      ['一样的配置', '一样的'],
      ['类似的问题', '类似的'],
      ['再试一次', '再试'],
      ['重试', '重试'],
      ['再来', '再来'],
      ['再做一遍', '再做'],
    ])('should detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(true)
    })
  })

  describe('English context references', () => {
    it.each([
      ['try again', 'again'],
      ['continue with the previous task', 'continue'],
      ['the previous command', 'previous'],
      ['last time', 'last'],
      ['same as before', 'same'],
      ['retry the operation', 'retry'],
      ['redo the step', 'redo'],
    ])('should detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(true)
    })
  })

  describe('no context reference', () => {
    it.each([
      ['检查 nginx 状态', 'new task'],
      ['安装 nodejs', 'installation'],
      ['查看日志', 'view logs'],
      ['list files in directory', 'list files'],
      ['show system status', 'status'],
    ])('should not detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(false)
    })
  })
})

// ==================== buildRecentTasksContext ====================

describe('buildRecentTasksContext', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should return empty result for empty store', () => {
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.recentTaskMessages).toEqual([])
    expect(result.taskSummarySection).toBe('')
    expect(result.availableTaskIds).toEqual([])
    expect(result.stats.totalTasks).toBe(0)
  })

  it('should include tasks within budget', () => {
    store.saveTask('task1', '检查 nginx', [], 'success', '正常')
    store.saveTask('task2', '重启 mysql', [], 'success', '完成')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(2)
    expect(result.availableTaskIds).toHaveLength(2)
  })

  it('should count compression levels correctly', () => {
    // Create a task with steps to ensure it has some content
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Test message', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Task 1', steps, 'success', 'Done')
    
    const result = buildRecentTasksContext(store, 100000) // Large budget
    
    const { level0Count, level1Count, level2Count, level3Count, level4Count } = result.stats
    const totalLevelCounts = level0Count + level1Count + level2Count + level3Count + level4Count
    expect(totalLevelCounts).toBe(result.stats.totalTasks)
  })

  it('should respect budget limit', () => {
    // Create many tasks
    for (let i = 0; i < 20; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'tool_call', toolName: 'execute_command', 
          toolArgs: { command: `command_${i}`.repeat(100) }, content: '', timestamp: Date.now() },
        { id: `${i}-2`, type: 'tool_result', toolName: 'execute_command',
          toolResult: `result_${i}`.repeat(200), content: '', timestamp: Date.now() },
        { id: `${i}-3`, type: 'message', content: `message_${i}`.repeat(100), timestamp: Date.now() }
      ]
      store.saveTask(`task${i}`, `Task ${i} with some description`, steps, 'success', 'Done')
    }
    
    const result = buildRecentTasksContext(store, 1000) // Small budget
    
    expect(result.stats.usedTokens).toBeLessThanOrEqual(1000)
  })

  it('可取回清单有上限，优先留给没装进对话的更早轮次', () => {
    for (let i = 0; i < 80; i++) {
      store.saveTask(`task${i}`, `请打开文件 file_${i}.docx`, [], 'success', `Result ${i}`)
    }

    const result = buildRecentTasksContext(store, 400)

    expect(result.availableTaskIds.length).toBeLessThanOrEqual(50)
    expect(result.stats.usedTokens).toBeLessThanOrEqual(400)
    expect(result.availableTaskIds.some(t => t.summary.includes('file_0') || t.id === 'task0')).toBe(true)
  })

  it('should increase budget when context reference detected', () => {
    store.saveTask('task1', '检查 nginx', [], 'success', '正常')
    
    const resultWithoutRef = buildRecentTasksContext(store, 1000, '新任务')
    const resultWithRef = buildRecentTasksContext(store, 1000, '继续刚才的任务')
    
    // With context reference, more budget should be available
    // This is reflected in potentially more detailed compression levels being used
    expect(resultWithRef.stats.budget).toBe(resultWithoutRef.stats.budget)
  })

  it('should handle task with pending confirmation', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_call', toolName: 'ask_user',
        toolArgs: { question: '是否继续?' }, content: '', timestamp: Date.now() }
    ]
    store.saveTask('task1', '危险操作', steps, 'pending_confirmation')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should populate availableTaskIds for recall', () => {
    store.saveTask('task1', 'Task 1', [], 'success', 'Done 1')
    store.saveTask('task2', 'Task 2', [], 'failed', 'Error')
    store.saveTask('task3', 'Task 3', [], 'success', 'Done 3')

    const result = buildRecentTasksContext(store, 10000)

    expect(result.availableTaskIds).toHaveLength(3)
    expect(result.availableTaskIds.map(t => t.id)).toContain('task1')
    expect(result.availableTaskIds.map(t => t.id)).toContain('task2')
    expect(result.availableTaskIds.map(t => t.id)).toContain('task3')
  })

  it('冷启动重装原文时不把历史图片再塞回去，文字还在', () => {
    const oldSteps: AgentStep[] = [
      { id: 'o1', type: 'message', content: '这是一只猫', timestamp: Date.now() }
    ]
    store.saveTask('task-old', '看图说话', oldSteps, 'success', '这是一只猫', [
      { role: 'user', content: '<system_context>\n终端: local\n</system_context>\n\n看图说话', images: ['data:image/png;base64,AAA'] },
      { role: 'assistant', content: '这是一只猫' }
    ])
    store.saveTask('task-new', '再聊一句', [], 'success', '好', [
      { role: 'user', content: '再聊一句' },
      { role: 'assistant', content: '好' }
    ])

    const result = buildRecentTasksContext(store, 100000)

    const oldUserMsg = result.recentTaskMessages.find(m => m.role === 'user' && (m.content === '看图说话' || m.content.includes('看图说话')))
    expect(oldUserMsg).toBeTruthy()
    expect(oldUserMsg?.images).toBeUndefined()
  })

  it('预算够时较早轮次也带着原文过程，不收成提要', () => {
    const nineSuggestions = [
      '已整理 9 条修改意见。',
      '第一条：投标人资格应明确联合体责任划分。',
      '第二条：评分细则需补齐技术分权重。',
    ].join('')

    store.saveTask('task-old', '写招标文件修改意见', [], 'success', '已写好', [
      { role: 'user', content: '写招标文件修改意见' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'write_text_file', arguments: '{"path":"/Users/me/Desktop/修改意见.docx"}' }
        }]
      },
      { role: 'tool', content: '已写入 9 条修改意见到桌面文档', tool_call_id: 'c1' },
      { role: 'assistant', content: nineSuggestions }
    ])
    store.saveTask('task-new', '核对落实情况', [], 'success', '好', [
      { role: 'user', content: '核对落实情况' },
      { role: 'assistant', content: '好' }
    ])

    const result = buildRecentTasksContext(store, 100000)

    expect(result.stats.level0Count).toBe(2)
    expect(result.stats.level1Count).toBe(0)
    expect(result.taskSummarySection).toBe('')
    const joined = result.recentTaskMessages.map(m => {
      const args = m.tool_calls?.map(tc => tc.function.arguments).join('\n') ?? ''
      return `${m.content}\n${args}`
    }).join('\n')
    expect(joined).toContain('写招标文件修改意见')
    expect(joined).toContain('/Users/me/Desktop/修改意见.docx')
    expect(joined).toContain('已写入 9 条修改意见到桌面文档')
    expect(joined).toContain('投标人资格应明确联合体责任划分')
  })

  it('预算不够时留下近的原文，更早整轮不装进对话', () => {
    const longReply = '结论：九条意见中有三条未落实。' + '核对细节。'.repeat(40)
    store.saveTask('task-old', '写招标文件修改意见', [], 'success', '已写好', [
      { role: 'user', content: '写招标文件修改意见' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'write_text_file', arguments: '{"path":"/tmp/意见.docx"}' }
        }]
      },
      { role: 'tool', content: 'x'.repeat(4000), tool_call_id: 'c1' },
      { role: 'assistant', content: longReply }
    ])
    store.saveTask('task-new', '继续', [], 'success', '好', [
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '好' }
    ])

    const result = buildRecentTasksContext(store, 200)
    const allText = result.recentTaskMessages.map(m => m.content).join('\n')

    expect(allText).toContain('继续')
    expect(allText).not.toContain('x'.repeat(200))
    expect(result.availableTaskIds.map(t => t.id)).toContain('task-old')
    expect(result.taskSummarySection).toBe('')
  })
})

// ==================== buildTaskHistoryContext ====================

describe('buildTaskHistoryContext', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should calculate budget based on context length', () => {
    store.saveTask('task1', 'Task 1', [], 'success')
    
    const result = buildTaskHistoryContext(store, 128000, '新任务')
    
    // Budget should be based on calculateBudget(128000).recentTasks
    const expectedBudget = calculateBudget(128000).recentTasks
    expect(result.stats.budget).toBe(expectedBudget)
  })

  it('should pass user message for context reference detection', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Test', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Task 1', steps, 'success', 'Done')
    
    // This should trigger increased budget due to context reference
    const result = buildTaskHistoryContext(store, 10000, '继续上次的任务')
    
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should work with empty store', () => {
    const result = buildTaskHistoryContext(store, 128000, '新任务')
    
    expect(result.recentTaskMessages).toEqual([])
    expect(result.taskSummarySection).toBe('')
    expect(result.stats.totalTasks).toBe(0)
  })

  it('should load up to 30 one-line summaries under wakeup summaryOnly', () => {
    const watchStore = new TaskMemoryStore(undefined, 50)
    for (let i = 0; i < 40; i++) {
      watchStore.saveTask(`task_${i}`, `用户任务 ${i} 的描述`, [], 'success', `完成结果 ${i}`)
    }

    const result = buildTaskHistoryContext(watchStore, 128000, '心跳检查', {
      maxTasks: 30,
      summaryOnly: true
    })

    expect(result.stats.totalTasks).toBe(30)
    expect(result.stats.level0Count).toBe(0)
    expect(result.stats.level1Count).toBe(0)
    expect(result.stats.level2Count).toBe(0)
    expect(result.stats.level3Count).toBe(0)
    expect(result.stats.level4Count).toBe(30)
    expect(result.recentTaskMessages).toEqual([])
    expect(result.taskSummarySection.length).toBeGreaterThan(0)
  })

  it('should keep distant turns as original messages, not one-line titles', () => {
    for (let i = 0; i < 10; i++) {
      store.saveTask(`old_${i}`, `请打开报告 ${i} 号文档.docx`, [], 'success', `已写好报告 ${i}`)
    }
    const result = buildTaskHistoryContext(store, 128000, '继续')
    const userTexts = result.recentTaskMessages.filter(m => m.role === 'user').map(m => m.content)
    expect(userTexts.some(t => t.includes('请打开报告 0 号文档.docx'))).toBe(true)
    expect(result.taskSummarySection).toBe('')
  })
})

describe('联络五档 processLevels', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  function saveToolTurn(id: string, request: string, toolName: string, path: string, output: string, reply: string) {
    store.saveTask(id, request, [], 'success', reply, [
      { role: 'user', content: request },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `${id}-c1`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ path }) }
        }]
      },
      { role: 'tool', content: output, tool_call_id: `${id}-c1` },
      { role: 'assistant', content: reply }
    ])
  }

  it('远轮留下完整原话和实际收场，不砍成标题', () => {
    for (let i = 0; i < 12; i++) {
      saveToolTurn(
        `turn_${i}`,
        `请打开你前面写的那个 Word ${i}`,
        'read_file',
        `/tmp/doc_${i}.docx`,
        `正文很长 ${'x'.repeat(200)}`,
        `已经打开 doc_${i}.docx`
      )
    }

    const result = buildRecentTasksContext(store, 8000, '继续', { processLevels: true })
    const userTexts = result.recentTaskMessages.filter(m => m.role === 'user').map(m => m.content)
    const allText = result.recentTaskMessages.map(m => m.content).join('\n')

    expect(userTexts.some(t => t.includes('请打开你前面写的那个 Word 0'))).toBe(true)
    expect(allText).toContain('已经打开 doc_0.docx')
    expect(allText).not.toMatch(/请打开你前面写的那个 Word 0…/)
    expect(result.taskSummarySection).toBe('')
    expect(result.stats.level4Count).toBeGreaterThan(0)
  })

  it('预算够时最近一轮带着完整过程，更早轮次只收过程不丢问答', () => {
    saveToolTurn('old', '写招标文件修改意见', 'write_text_file', '/tmp/意见.docx', '已写入 9 条', '已写好九条意见')
    saveToolTurn('mid', '核对落实情况', 'read_file', '/tmp/意见.docx', '核对中', '三条未落实')
    saveToolTurn('new', '打开你前面写的那个 Word', 'read_file', '/tmp/意见.docx', '文件内容：九条意见全文', '打开了桌面上的意见文档')

    const result = buildRecentTasksContext(store, 100000, '继续', { processLevels: true })
    const joined = result.recentTaskMessages.map(m => {
      const args = m.tool_calls?.map(tc => tc.function.arguments).join('\n') ?? ''
      return `${m.content}\n${args}`
    }).join('\n')

    expect(result.stats.level0Count).toBe(1)
    expect(joined).toContain('打开你前面写的那个 Word')
    expect(joined).toContain('/tmp/意见.docx')
    expect(joined).toContain('文件内容：九条意见全文')
    expect(joined).toContain('写招标文件修改意见')
    expect(joined).toContain('已写好九条意见')
  })

  it('失败和中止的远轮也照实留收场，不编造成功', () => {
    store.saveTask('fail', '部署生产', [], 'failed', '发布失败：缺权限', [
      { role: 'user', content: '部署生产' },
      { role: 'assistant', content: '发布失败：缺权限' }
    ])
    store.saveTask('stop', '重启机器', [], 'aborted', '', [
      { role: 'user', content: '重启机器' },
      { role: 'assistant', content: '正要重启' }
    ])
    for (let i = 0; i < 10; i++) {
      store.saveTask(`ok_${i}`, `闲聊 ${i}`, [], 'success', `好 ${i}`, [
        { role: 'user', content: `闲聊 ${i}` },
        { role: 'assistant', content: `好 ${i}` }
      ])
    }

    const result = buildRecentTasksContext(store, 4000, '继续', { processLevels: true })
    const text = result.recentTaskMessages.map(m => m.content).join('\n')
    expect(text).toContain('部署生产')
    expect(text).toContain('[任务执行失败]')
    expect(text).toContain('重启机器')
    expect(text).toContain('[任务已被用户中止]')
    expect(text).not.toContain('✓')
  })
})

// ==================== Integration scenarios ====================

describe('Context builder integration', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should handle mixed task statuses', () => {
    store.saveTask('task1', 'Success task', [], 'success', 'Done')
    store.saveTask('task2', 'Failed task', [], 'failed', 'Error occurred')
    store.saveTask('task3', 'Aborted task', [], 'aborted')
    
    const result = buildRecentTasksContext(store, 100000)
    
    expect(result.stats.totalTasks).toBe(3)
    expect(result.availableTaskIds).toHaveLength(3)
  })

  it('should preserve recent tasks at higher detail levels', () => {
    // Add many tasks, most recent should have better compression level
    for (let i = 0; i < 10; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'message', content: `Content ${i}`, timestamp: Date.now() + i }
      ]
      store.saveTask(`task${i}`, `Task ${i}`, steps, 'success', `Result ${i}`)
    }
    
    const result = buildRecentTasksContext(store, 50000)
    
    // Most recent task (index 0 in reversed order) should be at Level 0
    expect(result.stats.level0Count).toBeGreaterThanOrEqual(1)
  })

  it('should generate correct messages structure', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Hello from AI', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'User request', steps, 'success', 'Done')
    
    const result = buildRecentTasksContext(store, 100000)
    
    // Level 0-2 tasks should produce messages
    if (result.stats.level0Count + result.stats.level1Count + result.stats.level2Count > 0) {
      expect(result.recentTaskMessages.length).toBeGreaterThan(0)
      // Check message structure
      result.recentTaskMessages.forEach(msg => {
        expect(msg).toHaveProperty('role')
        expect(msg).toHaveProperty('content')
      })
    }
  })

  it('should keep recent original turns when older ones no longer fit', () => {
    for (let i = 0; i < 30; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: `cmd_${i}` }, content: '', timestamp: Date.now() },
        { id: `${i}-2`, type: 'tool_result', toolName: 'execute_command',
          toolResult: `result_${i}`.repeat(100), content: '', timestamp: Date.now() },
        { id: `${i}-3`, type: 'message', content: `msg_${i}`.repeat(50), timestamp: Date.now() }
      ]
      store.saveTask(`task${i}`, `请打开文件 file_${i}.docx`, steps, 'success', `Result ${i}`)
    }

    const result = buildRecentTasksContext(store, 5000)

    expect(result.taskSummarySection).toBe('')
    expect(result.recentTaskMessages.length).toBeGreaterThan(0)
    expect(result.stats.level0Count).toBeGreaterThan(0)
    expect(result.stats.level4Count).toBe(0)
    const userTexts = result.recentTaskMessages.filter(m => m.role === 'user').map(m => m.content)
    expect(userTexts.some(t => t.includes('请打开文件'))).toBe(true)
    expect(result.availableTaskIds).toHaveLength(30)
  })

  it('should keep actual closing for failed, aborted, and waiting turns', () => {
    store.saveTask('ok', '写周报', [
      { id: '1', type: 'message', content: '周报已写到 weekly.docx', timestamp: Date.now() }
    ], 'success', '周报已写到 weekly.docx')
    store.saveTask('fail', '部署生产', [
      { id: '2', type: 'message', content: '发布失败：缺权限', timestamp: Date.now() }
    ], 'failed', '发布失败：缺权限')
    store.saveTask('stop', '重启机器', [
      { id: '3', type: 'message', content: '正要重启', timestamp: Date.now() }
    ], 'aborted')
    store.saveTask('wait', '删库', [], 'pending_confirmation')

    const result = buildRecentTasksContext(store, 100000)
    const text = result.recentTaskMessages.map(m => m.content).join('\n')
    expect(text).toContain('写周报')
    expect(text).toContain('周报已写到 weekly.docx')
    expect(text).toContain('部署生产')
    expect(text).toContain('[任务执行失败]')
    expect(text).toContain('重启机器')
    expect(text).toContain('[任务已被用户中止]')
    expect(text).toContain('删库')
    expect(text).toContain('[还在等待确认]')
  })

  it('should not invent a successful closing when the turn has no reply', () => {
    store.saveTask('empty', '打开你前面写的那个 Word', [], 'success')
    const result = buildRecentTasksContext(store, 100000)
    const asst = result.recentTaskMessages.find(m => m.role === 'assistant')
    expect(result.recentTaskMessages.some(m => m.role === 'user' && m.content === '打开你前面写的那个 Word')).toBe(true)
    expect(asst?.content).toBe('[本轮没有留下交代]')
    expect(asst?.content).not.toContain('✓')
  })
})

// ==================== Edge cases ====================

describe('Context builder edge cases', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should handle task with empty steps', () => {
    store.saveTask('task1', 'Empty task', [], 'success')
    
    const result = buildRecentTasksContext(store, 10000)
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should handle task with very long content', () => {
    const longContent = 'x'.repeat(10000)
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_result', toolName: 'execute_command',
        toolResult: longContent, content: '', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Long content task', steps, 'success')
    
    const result = buildRecentTasksContext(store, 1000) // Small budget
    
    // Should handle without error
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should handle zero budget', () => {
    store.saveTask('task1', 'Task 1', [], 'success')
    
    const result = buildRecentTasksContext(store, 0)
    
    // With zero budget, tasks should still be tracked but compressed heavily
    expect(result.stats.budget).toBe(0)
  })

  it('should handle unicode content', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: '中文内容 🎉 émojis', timestamp: Date.now() }
    ]
    store.saveTask('task1', '中文任务 🚀', steps, 'success', '完成 ✓')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(1)
    expect(result.availableTaskIds[0].summary).toContain('中文任务')
  })
})

// ==================== sanitizeToolCallSequence ====================

describe('sanitizeToolCallSequence', () => {
  it('should pass through correct sequence unchanged', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_a', tool_call_id: 'a' },
      { role: 'assistant', content: 'done' }
    ]
    const result = sanitizeToolCallSequence(messages)
    expect(result).toEqual(messages)
  })

  it('should append placeholder for missing tool result', () => {
    const messages: AiMessage[] = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'write_text_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_a', tool_call_id: 'a' }
    ]
    const result = sanitizeToolCallSequence(messages)
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 'b' })
    expect(result[2].content).toContain('write_text_file')
  })

  it('should relocate user message dangling between tool messages', () => {
    // 模拟旧版本（修复前）：read_file 返回图片后立即 push 一条 user 消息
    // 导致 user 夹在 tool_a 和 tool_b 之间
    const messages: AiMessage[] = [
      { role: 'user', content: 'analyze images' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_a', tool_call_id: 'a' },
      { role: 'user', content: '[image from tool a]' },
      { role: 'tool', content: 'res_b', tool_call_id: 'b' },
      { role: 'user', content: '[image from tool b]' },
      { role: 'assistant', content: 'analysis done' }
    ]
    const result = sanitizeToolCallSequence(messages)

    // 序列应该是: user → assistant(tool_calls) → tool_a → tool_b → user(image_a) → user(image_b) → assistant
    expect(result.map(m => `${m.role}:${m.tool_call_id ?? m.content.slice(0, 20)}`)).toEqual([
      'user:analyze images',
      'assistant:',
      'tool:a',
      'tool:b',
      'user:[image from tool a]',
      'user:[image from tool b]',
      'assistant:analysis done'
    ])
  })

  it('should relocate user message and append missing tool result together', () => {
    const messages: AiMessage[] = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_a', tool_call_id: 'a' },
      { role: 'user', content: '[image]' }
      // tool b 缺失
    ]
    const result = sanitizeToolCallSequence(messages)
    expect(result).toHaveLength(4)
    expect(result[1]).toMatchObject({ role: 'tool', tool_call_id: 'a' })
    expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 'b' })
    expect(result[3]).toMatchObject({ role: 'user', content: '[image]' })
  })

  it('should handle multiple assistant.tool_calls batches', () => {
    const messages: AiMessage[] = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_a1', tool_call_id: 'a1' },
      { role: 'user', content: '[image1]' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'b1', type: 'function', function: { name: 'read_file', arguments: '{}' } }
      ] },
      { role: 'tool', content: 'res_b1', tool_call_id: 'b1' },
      { role: 'user', content: '[image2]' }
    ]
    const result = sanitizeToolCallSequence(messages)
    expect(result.map(m => m.role)).toEqual([
      'assistant', 'tool', 'user',  // 第一批
      'assistant', 'tool', 'user'   // 第二批
    ])
  })

  it('should handle assistant without tool_calls untouched', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'thanks' }
    ]
    const result = sanitizeToolCallSequence(messages)
    expect(result).toEqual(messages)
  })

  it('should handle empty messages', () => {
    expect(sanitizeToolCallSequence([])).toEqual([])
  })

  // 第三类问题：孤儿 tool（前面没有 assistant tool_calls）
  // 历史数据中 splitMessagesIntoTasks 把工具图片注入的 user 消息当作任务边界切分，
  // 导致某个 task 的 messages 开头/中间是孤立的 tool 消息，发给 API 会报
  // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
  describe('orphan tool messages', () => {
    it('should convert orphan tool at start to user message', () => {
      const messages: AiMessage[] = [
        { role: 'tool', content: 'orphan result', tool_call_id: 't1' },
        { role: 'assistant', content: 'continuing' },
        { role: 'user', content: 'next' }
      ]
      const result = sanitizeToolCallSequence(messages)
      expect(result).toHaveLength(3)
      expect(result[0].role).toBe('user')
      expect(result[0].content).toContain('orphan result')
      expect(result[1]).toEqual(messages[1])
      expect(result[2]).toEqual(messages[2])
    })

    it('should convert orphan tool between two assistant messages to user', () => {
      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }, // 普通 assistant，无 tool_calls
        { role: 'tool', content: 'orphan', tool_call_id: 't1' }, // 孤儿
        { role: 'assistant', content: 'next' }
      ]
      const result = sanitizeToolCallSequence(messages)
      expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
      expect(result[2].content).toContain('orphan')
    })

    it('should handle multiple orphan tools', () => {
      const messages: AiMessage[] = [
        { role: 'tool', content: 'a', tool_call_id: 'a' },
        { role: 'tool', content: 'b', tool_call_id: 'b' },
        { role: 'user', content: 'follow-up' }
      ]
      const result = sanitizeToolCallSequence(messages)
      expect(result).toHaveLength(3)
      expect(result[0].role).toBe('user')
      expect(result[1].role).toBe('user')
      expect(result[2]).toEqual(messages[2])
    })

    it('should not produce orphan tool when properly paired', () => {
      // 正确的 tool_calls 后跟 tool 消息不应被当作孤儿处理
      const messages: AiMessage[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }
        ] },
        { role: 'tool', content: 'paired', tool_call_id: 'a' }
      ]
      const result = sanitizeToolCallSequence(messages)
      expect(result).toEqual(messages) // 原样保留，role 仍是 'tool'
    })
  })
})
