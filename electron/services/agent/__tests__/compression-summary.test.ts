/**
 * compression-summary 单元测试
 *
 * 验证主动压缩的 AI 小结输入装配：
 * - 用户/助手文本、工具名、工具输出头部进转录；system 不进
 * - 图片以 [图片] 占位，不送摘要
 * - 单条消息与整体输入都有上限（整体超限保留头尾）
 */
import { describe, it, expect } from 'vitest'
import { formatMessagesForSummary, capSummaryInput } from '../compression-summary'
import type { AiMessage } from '../../ai.service'

const user = (content: string, images?: string[]): AiMessage => ({ role: 'user', content, ...(images ? { images } : {}) })
const asst = (content: string, toolCalls?: AiMessage['tool_calls']): AiMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { tool_calls: toolCalls } : {})
})
const tool = (id: string, content: string): AiMessage => ({ role: 'tool', content, tool_call_id: id })
const tc = (id: string, name: string, args = '{}') => ({ id, type: 'function' as const, function: { name, arguments: args } })

describe('formatMessagesForSummary', () => {
  it('用户/助手/工具输出都进转录，system 不进', () => {
    const out = formatMessagesForSummary([
      { role: 'system', content: '你是助手' },
      user('评审这些 PDF'),
      asst('好的', [tc('c1', 'read_file', '{"path":"/a.pdf"}')]),
      tool('c1', '文件内容……')
    ])
    expect(out).not.toContain('你是助手')
    expect(out).toContain('[用户] 评审这些 PDF')
    expect(out).toContain('[助手] 好的')
    expect(out).toContain('read_file(')
    expect(out).toContain('[工具输出] 文件内容……')
  })

  it('图片以占位标记进转录，不带 base64', () => {
    const out = formatMessagesForSummary([user('看这张截图', ['data:image/png;base64,xxxx'])])
    expect(out).toContain('[图片×1]')
    expect(out).not.toContain('base64')
  })

  it('单条工具输出超长 → 只保留头部（指针 notice 在头部）', () => {
    const pointer = '[完整输出共 99999 字符，已保存到: /scratch/tool-outputs/x.txt]'
    const out = formatMessagesForSummary([tool('c1', pointer + '\n' + 'A'.repeat(5000))])
    expect(out).toContain(pointer)
    expect(out.length).toBeLessThan(pointer.length + 600)
  })

  it('空消息集合 → 空串', () => {
    expect(formatMessagesForSummary([])).toBe('')
    expect(formatMessagesForSummary([{ role: 'system', content: 'x' }])).toBe('')
  })
})

describe('capSummaryInput', () => {
  it('预算内原样返回', () => {
    expect(capSummaryInput('short', 1000)).toBe('short')
  })

  it('超预算保留头尾，中间标记省略', () => {
    const text = '头'.repeat(2000) + '中'.repeat(6000) + '尾'.repeat(2000)
    const out = capSummaryInput(text, 500) // 预算 500 token ≈ 1000 字符
    expect(out).toContain('头')
    expect(out).toContain('尾')
    expect(out).toContain('省略')
    expect(out.length).toBeLessThan(text.length / 2)
  })
})
