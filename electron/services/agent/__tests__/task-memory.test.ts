/**
 * task-memory.ts 单元测试
 * 测试任务记忆存储的关键词提取、相似度计算、摘要生成等功能
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  TaskMemoryStore,
  extractKeywords,
  calculateKeywordOverlap,
  detectPendingConfirmation,
  generateSummary,
  cleanSummarySource,
  extractDigest
} from '../task-memory'
import type { AgentStep } from '../types'
import type { ToolMeta } from '../tools'

/**
 * 测试用 ToolMeta lookup：还原原始硬编码两处行为的等价语义。
 * - ask_user 声明 lifecycle.blocksUntilUserInput = true（曾经的 ask_user 硬编码判定）
 * - execute_command / exec 声明 argRole.summaryLine = 'command'（曾经的命令抽取硬编码判定）
 */
function lookupMeta(toolName: string): ToolMeta | undefined {
  if (toolName === 'ask_user') return { lifecycle: { blocksUntilUserInput: true } }
  if (toolName === 'execute_command' || toolName === 'exec') return { argRole: { summaryLine: 'command' } }
  return undefined
}

// ==================== extractKeywords ====================

describe('extractKeywords', () => {
  describe('service names extraction', () => {
    it.each([
      ['检查 nginx 状态', 'nginx'],
      ['重启 mysql 服务', 'mysql'],
      ['postgresql 连接问题', 'postgresql'],
      ['redis 缓存', 'redis'],
      ['mongodb 数据库', 'mongodb'],
      ['docker 容器', 'docker'],
      ['kubernetes 集群', 'kubernetes'],
      ['systemctl status', 'systemctl'],
      ['使用 git pull', 'git'],
      ['运行 npm install', 'npm'],
      ['执行 python 脚本', 'python'],
    ])('should extract service name from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('file path extraction', () => {
    it('should extract absolute paths', () => {
      const keywords = extractKeywords('编辑 /etc/nginx/nginx.conf 文件')
      expect(keywords).toContain('/etc/nginx/nginx.conf')
    })

    it('should extract multiple paths', () => {
      const keywords = extractKeywords('从 /var/log/syslog 复制到 /tmp/backup')
      expect(keywords).toContain('/var/log/syslog')
      expect(keywords).toContain('/tmp/backup')
    })
  })

  describe('port extraction', () => {
    it.each([
      ['端口 80', 'port:80'],
      ['port 443', 'port:443'],
      ['ssh 22', 'port:22'],
      ['MySQL 3306', 'port:3306'],
      ['PostgreSQL 5432', 'port:5432'],
      ['Redis 6379', 'port:6379'],
      ['开发服务器 8080', 'port:8080'],
    ])('should extract port from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('IP address extraction', () => {
    it('should extract IP addresses', () => {
      const keywords = extractKeywords('连接到 192.168.1.100')
      expect(keywords).toContain('192.168.1.100')
    })

    it('should extract multiple IPs', () => {
      const keywords = extractKeywords('从 10.0.0.1 到 10.0.0.2')
      expect(keywords).toContain('10.0.0.1')
      expect(keywords).toContain('10.0.0.2')
    })
  })

  describe('error keywords extraction', () => {
    it.each([
      ['error occurred', 'error'],
      ['connection failed', 'failed'],
      ['permission denied', 'denied'],
      ['connection refused', 'refused'],
      ['request timeout', 'timeout'],
      ['file not found', 'not found'],
      ['unauthorized access', 'unauthorized'],
      ['forbidden', 'forbidden'],
    ])('should extract error keyword from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('deduplication', () => {
    it('should deduplicate keywords', () => {
      const keywords = extractKeywords('nginx nginx nginx')
      const nginxCount = keywords.filter(k => k === 'nginx').length
      expect(nginxCount).toBe(1)
    })
  })
})

// ==================== calculateKeywordOverlap ====================

describe('calculateKeywordOverlap', () => {
  it('should return 0 for empty arrays', () => {
    expect(calculateKeywordOverlap([], ['nginx'])).toBe(0)
    expect(calculateKeywordOverlap(['nginx'], [])).toBe(0)
    expect(calculateKeywordOverlap([], [])).toBe(0)
  })

  it('should return 0 for no overlap', () => {
    const score = calculateKeywordOverlap(['nginx', 'config'], ['mysql', 'backup'])
    expect(score).toBe(0)
  })

  it('should return positive score for exact match', () => {
    const score = calculateKeywordOverlap(['nginx'], ['nginx'])
    expect(score).toBeGreaterThan(0)
  })

  it('should return higher score for more matches', () => {
    const score1 = calculateKeywordOverlap(['nginx'], ['nginx', 'mysql'])
    const score2 = calculateKeywordOverlap(['nginx', 'config'], ['nginx', 'config'])
    expect(score2).toBeGreaterThan(score1)
  })

  it('should handle partial matches (path containment)', () => {
    const score = calculateKeywordOverlap(['/etc/nginx'], ['/etc/nginx/nginx.conf'])
    expect(score).toBeGreaterThan(0)
  })

  it('should be case insensitive', () => {
    const score = calculateKeywordOverlap(['NGINX'], ['nginx'])
    expect(score).toBeGreaterThan(0)
  })
})

// ==================== detectPendingConfirmation ====================

describe('detectPendingConfirmation', () => {
  it('should detect pending ask_user without response', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: '是否继续?' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps, lookupMeta)
    expect(result.isPending).toBe(true)
    expect(result.pendingAction).toBe('是否继续?')
  })

  it('should not detect when ask_user has response', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: '是否继续?' },
        content: '',
        timestamp: Date.now()
      },
      {
        id: '2',
        type: 'tool_result',
        toolName: 'ask_user',
        toolResult: '是',
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps, lookupMeta)
    expect(result.isPending).toBe(false)
  })

  it('should truncate long questions', () => {
    const longQuestion = 'a'.repeat(100)
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: longQuestion },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps, lookupMeta)
    expect(result.pendingAction!.length).toBeLessThanOrEqual(53) // 50 + '...'
  })

  it('should return not pending for empty steps', () => {
    const result = detectPendingConfirmation([], lookupMeta)
    expect(result.isPending).toBe(false)
  })

  it('should handle steps without ask_user', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'ls' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps, lookupMeta)
    expect(result.isPending).toBe(false)
  })
})

// ==================== generateSummary ====================

describe('generateSummary', () => {
  it('should generate success summary with icon', () => {
    const summary = generateSummary('检查 nginx', 'success', '服务正常')
    expect(summary).toContain('✓')
    expect(summary).toContain('检查 nginx')
  })

  it('should generate failed summary with icon', () => {
    const summary = generateSummary('安装软件', 'failed', '安装失败')
    expect(summary).toContain('✗')
  })

  it('should generate aborted summary', () => {
    const summary = generateSummary('长任务', 'aborted')
    expect(summary).toContain('⊘')
    expect(summary).toContain('已中止')
  })

  it('should generate pending confirmation summary', () => {
    const summary = generateSummary('危险操作', 'pending_confirmation', '', '是否删除?')
    expect(summary).toContain('⏳')
    expect(summary).toContain('等待确认')
    expect(summary).toContain('是否删除?')
  })

  it('should truncate long requests', () => {
    const longRequest = 'a'.repeat(200)
    const summary = generateSummary(longRequest, 'success')
    expect(summary.length).toBeLessThan(longRequest.length + 20)
  })

  it('should NOT truncate requests within budget (no beheading at 30 chars)', () => {
    // 设计意图是「一句话概要」，50 字以内的完整短句应原样保留
    const request = '帮我把 agent/SPEC.md 里的 wakeup 历史装载策略章节改写得更简洁一点'
    const summary = generateSummary(request, 'success')
    expect(summary).toContain(request)
    expect(summary).not.toContain('…')
  })

  it('should truncate at sentence boundary when over budget', () => {
    // 超预算时按句边界降级，保住完整短句
    const firstSentence = '先检查 nginx 配置。'
    const longTail = '再把所有日志文件打包上传到远程服务器，'.repeat(10)
    const summary = generateSummary(firstSentence + longTail, 'success')
    expect(summary).toContain('先检查 nginx 配置。')
    expect(summary).not.toContain('上传')
  })

  it('should fall back to char truncation with ellipsis for one huge sentence', () => {
    // 单句就超预算 → 兜底按字截 + 省略号（防注入长文本撑爆 L4）
    const huge = '需要处理的清单：' + '细节'.repeat(100)
    const summary = generateSummary(huge, 'success')
    expect(summary).toContain('需要处理的清单：')
    expect(summary).toContain('…')
    expect(summary).not.toContain('细节'.repeat(100))
  })

  it('should strip injected wrappers (uploaded docs, knowledge refs, image notes)', () => {
    // 注入包裹是系统材料，不应进概要；用户自己的话（首行）应完整保留
    const userMessage = [
      '<sf_knowledge_refs>\n召回的知识条目 1\n召回的知识条目 2\n</sf_knowledge_refs>',
      '<sf_user_message>\n帮我总结这份文档的要点\n</sf_user_message>',
      '<sf_uploaded_docs>\n很长的文档全文，'.repeat(50) + '\n</sf_uploaded_docs>',
      '[系统：用户在本消息中附带了 2 张图片（见 images 字段）]'
    ].join('\n\n')
    const summary = generateSummary(userMessage, 'success')
    expect(summary).toContain('帮我总结这份文档的要点')
    expect(summary).not.toContain('知识条目')
    expect(summary).not.toContain('文档全文')
    expect(summary).not.toContain('sf_')
  })

  it('should keep attachment placeholder when message has no user text of its own', () => {
    // 用户只发文档/图片没说话：概要应留下轻量占位，而非空串或文档全文
    const docsOnly = '<sf_uploaded_docs>\n' + '很长的文档全文，'.repeat(50) + '\n</sf_uploaded_docs>'
    const summary = generateSummary(docsOnly, 'success')
    expect(summary).toContain('（附文档）')
    expect(summary).not.toContain('文档全文')
    const imageOnly = '[系统：用户在本消息中附带了 2 张图片（见 images 字段）]'
    expect(generateSummary(imageOnly, 'success')).toContain('（附图片）')
  })

  it('should strip thinking details blocks from result summary', () => {
    const result = '<details><summary>思考</summary>内部推理过程</details>分析结论是一切正常。'
    const summary = generateSummary('查询', 'success', result)
    expect(summary).toContain('分析结论是一切正常。')
    expect(summary).not.toContain('思考')
    expect(summary).not.toContain('details')
  })

  it('should include result summary', () => {
    const summary = generateSummary('查询', 'success', '找到 10 条记录')
    expect(summary).toContain('找到 10 条记录')
  })

  it('should include time prefix when timestamp provided', () => {
    // L4 摘要带时间前缀，让 AI 在压缩历史中能看到任务发生的时间
    // 格式对齐 AI 消息包体（new Date(ts).toLocaleString()，跟随系统 locale）
    const ts = new Date(2026, 6, 3, 14, 25, 30).getTime() // 2026-07-03 14:25:30
    const summary = generateSummary('检查 nginx', 'success', '服务正常', undefined, ts)
    // 前缀以 [ 开头 ] 结尾，含年份 2026 和时分秒（locale 无关的结构性断言）
    expect(summary).toMatch(/^\[.*2026.*\d{1,2}:\d{2}:\d{2}.*\] /)
    expect(summary).toContain('✓')
    expect(summary).toContain('检查 nginx')
  })

  it('should omit time prefix when timestamp omitted (backward compat)', () => {
    // 旧调用方不传 timestamp 时，summary 不带时间前缀，保持向后兼容
    const summary = generateSummary('检查 nginx', 'success', '服务正常')
    expect(summary).not.toMatch(/^\[/) // 不以 [ 开头
    expect(summary).toContain('✓')
  })
})

// ==================== cleanSummarySource ====================

describe('cleanSummarySource', () => {
  it('strips sf_system_context block', () => {
    const text = '<sf_system_context>\n当前目录是 /tmp\n</sf_system_context>\n用户的话'
    expect(cleanSummarySource(text)).toBe('用户的话')
  })

  it('strips closed details block anywhere', () => {
    expect(cleanSummarySource('<details><summary>思</summary>推理</details>最终答案')).toBe('最终答案')
  })

  it('strips unclosed details only at message start (truncated thinking)', () => {
    // 思考块恒在开头；流式截断的未闭合思考块剥到空是可接受的
    expect(cleanSummarySource('<details><summary>思</summary>未闭合的推理被截断')).toBe('')
  })

  it('keeps mid-text unclosed details as user text', () => {
    // 正文中段的 <details 视为用户文本（不误吞正文），只剥标签本身
    expect(cleanSummarySource('先说说需求\n<details>这里还没写完')).toBe('先说说需求\n这里还没写完')
  })

  it('does NOT eat comparison/math text as HTML tag', () => {
    // `3 < 5 and 7 > 2` 中没有合法标签（< 后必须紧跟字母），文本应保留
    expect(cleanSummarySource('判断 3 < 5 and 7 > 2 是否成立')).toContain('3 < 5 and 7 > 2')
  })

  it('is stable on already-cleaned text', () => {
    const dirty = '<sf_knowledge_refs>\n召回\n</sf_knowledge_refs>\n帮我查日志'
    const once = cleanSummarySource(dirty)
    expect(cleanSummarySource(once)).toBe(once)
  })
})

// ==================== extractDigest ====================

describe('extractDigest', () => {
  it('should extract commands from steps', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'systemctl status nginx' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '检查 nginx', lookupMeta)
    expect(digest.commands).toContain('systemctl status nginx')
  })

  it('should extract services from commands', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'systemctl restart mysql' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '', lookupMeta)
    expect(digest.services).toContain('mysql')
  })

  it('should extract paths from commands', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'cat /etc/nginx/nginx.conf' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '', lookupMeta)
    expect(digest.paths).toContain('/etc/nginx/nginx.conf')
  })

  it('should extract errors from results', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_result',
        toolName: 'execute_command',
        toolResult: 'Error: connection refused',
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '', lookupMeta)
    expect(digest.errors.length).toBeGreaterThan(0)
  })

  it('should extract key findings from messages', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'message',
        content: '发现: 服务未启动\n原因: 配置文件错误',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '', lookupMeta)
    expect(digest.keyFindings.length).toBeGreaterThan(0)
  })

  it('should extract services from user request', () => {
    const digest = extractDigest([], '检查 redis 和 nginx 状态', lookupMeta)
    expect(digest.services).toContain('redis')
    expect(digest.services).toContain('nginx')
  })

  it('should limit arrays to prevent overflow', () => {
    const steps: AgentStep[] = Array(20).fill(null).map((_, i) => ({
      id: String(i),
      type: 'tool_call' as const,
      toolName: 'execute_command',
      toolArgs: { command: `command_${i}` },
      content: '',
      timestamp: Date.now()
    }))
    
    const digest = extractDigest(steps, '', lookupMeta)
    expect(digest.commands.length).toBeLessThanOrEqual(10)
  })
})

// ==================== TaskMemoryStore ====================

describe('TaskMemoryStore', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore(lookupMeta)
  })

  describe('saveTask', () => {
    it('should save task and return memory', () => {
      const memory = store.saveTask('task1', '检查 nginx', [], 'success', '正常')
      
      expect(memory.id).toBe('task1')
      expect(memory.userRequest).toBe('检查 nginx')
      expect(memory.status).toBe('success')
      expect(memory.summary).toContain('✓')
    })

    it('should update existing task', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      store.saveTask('task1', '检查 nginx 更新', [], 'failed')
      
      expect(store.getTaskCount()).toBe(1)
      const task = store.getTask('task1')
      expect(task?.userRequest).toBe('检查 nginx 更新')
    })

    it('should limit max memories', () => {
      // Create store with small limit for testing
      const smallStore = new TaskMemoryStore(lookupMeta)
      // @ts-expect-error - accessing private property for testing
      smallStore.maxMemories = 3
      
      smallStore.saveTask('task1', 'Task 1', [], 'success')
      smallStore.saveTask('task2', 'Task 2', [], 'success')
      smallStore.saveTask('task3', 'Task 3', [], 'success')
      smallStore.saveTask('task4', 'Task 4', [], 'success')
      
      expect(smallStore.getTaskCount()).toBe(3)
      expect(smallStore.hasTask('task1')).toBe(false)
      expect(smallStore.hasTask('task4')).toBe(true)
    })
  })

  describe('getSummaries', () => {
    it('should return summaries in reverse chronological order', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const summaries = store.getSummaries()
      expect(summaries[0].id).toBe('task3')
      expect(summaries[2].id).toBe('task1')
    })

    it('should respect limit', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const summaries = store.getSummaries(2)
      expect(summaries).toHaveLength(2)
    })

    it('should return empty array for empty store', () => {
      const summaries = store.getSummaries()
      expect(summaries).toEqual([])
    })
  })

  describe('getRelatedDigests', () => {
    beforeEach(() => {
      store.saveTask('task1', '检查 nginx 状态', [
        { id: '1', type: 'tool_call', toolName: 'execute_command', 
          toolArgs: { command: 'systemctl status nginx' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      store.saveTask('task2', '重启 mysql 服务', [
        { id: '2', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'systemctl restart mysql' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      store.saveTask('task3', '查看磁盘空间', [
        { id: '3', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'df -h' }, content: '', timestamp: Date.now() }
      ], 'success')
    })

    it('should return related tasks by keyword', () => {
      const related = store.getRelatedDigests('nginx 配置')
      expect(related.length).toBeGreaterThan(0)
      expect(related[0].taskId).toBe('task1')
    })

    it('should return empty for no matches', () => {
      const related = store.getRelatedDigests('completely unrelated query')
      expect(related).toEqual([])
    })

    it('should respect topK limit', () => {
      const related = store.getRelatedDigests('systemctl', 1)
      expect(related.length).toBeLessThanOrEqual(1)
    })

    it('should return empty for empty query', () => {
      const related = store.getRelatedDigests('')
      expect(related).toEqual([])
    })
  })

  describe('getDigest', () => {
    it('should return digest for existing task', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      const result = store.getDigest('task1')
      
      expect(result).not.toBeNull()
      expect(result!.userRequest).toBe('检查 nginx')
    })

    it('should return null for non-existent task', () => {
      expect(store.getDigest('non-existent')).toBeNull()
    })
  })

  describe('getFullSteps', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_call', toolName: 'execute_command', content: '', timestamp: Date.now() },
      { id: '2', type: 'tool_result', toolName: 'execute_command', content: '', timestamp: Date.now() }
    ]

    beforeEach(() => {
      store.saveTask('task1', 'Task', steps, 'success')
    })

    it('should return all steps', () => {
      const result = store.getFullSteps('task1')
      expect(Array.isArray(result)).toBe(true)
      expect((result as AgentStep[]).length).toBe(2)
    })

    it('should return specific step by index', () => {
      const result = store.getFullSteps('task1', 0)
      expect((result as AgentStep).id).toBe('1')
    })

    it('should return null for invalid index', () => {
      expect(store.getFullSteps('task1', 99)).toBeNull()
      expect(store.getFullSteps('task1', -1)).toBeNull()
    })

    it('should return null for non-existent task', () => {
      expect(store.getFullSteps('non-existent')).toBeNull()
    })
  })

  describe('utility methods', () => {
    it('getTaskCount should return correct count', () => {
      expect(store.getTaskCount()).toBe(0)
      store.saveTask('task1', 'Task 1', [], 'success')
      expect(store.getTaskCount()).toBe(1)
    })

    it('hasTask should check existence', () => {
      expect(store.hasTask('task1')).toBe(false)
      store.saveTask('task1', 'Task 1', [], 'success')
      expect(store.hasTask('task1')).toBe(true)
    })

    it('getTask should return full task', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      const task = store.getTask('task1')
      expect(task).not.toBeNull()
      expect(task!.id).toBe('task1')
    })

    it('clear should remove all tasks', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.clear()
      expect(store.getTaskCount()).toBe(0)
    })
  })

  describe('getTasksInOrder', () => {
    it('should return tasks in reverse chronological order', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const tasks = store.getTasksInOrder()
      expect(tasks[0].id).toBe('task3')
      expect(tasks[2].id).toBe('task1')
    })
  })

  describe('formatSummariesForContext', () => {
    it('should format summaries as list', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      store.saveTask('task2', '重启 mysql', [], 'failed')
      
      const formatted = store.formatSummariesForContext()
      expect(formatted).toContain('[task1]')
      expect(formatted).toContain('[task2]')
    })

    it('should return empty string for empty store', () => {
      expect(store.formatSummariesForContext()).toBe('')
    })
  })

  describe('formatRelatedDigestsForContext', () => {
    it('should format digests with details', () => {
      store.saveTask('task1', '检查 nginx 状态', [
        { id: '1', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'systemctl status nginx' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      const digests = store.getRelatedDigests('nginx')
      const formatted = store.formatRelatedDigestsForContext(digests)
      
      expect(formatted).toContain('task1')
      expect(formatted).toContain('命令')
    })

    it('should return empty string for empty digests', () => {
      expect(store.formatRelatedDigestsForContext([])).toBe('')
    })
  })
})
