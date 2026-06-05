import { describe, it, expect } from 'vitest'
import { assembleUserMessageContent, wrapKnowledgeRefs, wrapUserMessage } from '../message-envelope'

describe('message-envelope', () => {
  it('wraps knowledge refs and user message separately', () => {
    const out = assembleUserMessageContent({
      knowledgeRefs: wrapKnowledgeRefs('### doc1\nold chat about safety'),
      userMessage: '[2026-06-04 16:15 周四] 分析官网安全弱点',
    })
    expect(out).toContain('<sf_knowledge_refs>')
    expect(out).toContain('<sf_user_message>')
    expect(out.indexOf('<sf_knowledge_refs>')).toBeLessThan(out.indexOf('<sf_user_message>'))
    expect(out).toContain('分析官网安全弱点')
  })

  it('wrapUserMessage preserves timestamp prefix inside tag', () => {
    const wrapped = wrapUserMessage('[2026-06-04 16:15 周四] hello')
    expect(wrapped).toBe('<sf_user_message>\n[2026-06-04 16:15 周四] hello\n</sf_user_message>')
  })

  it('appends imageNote as plain text, not inside a second sf_user_message tag', () => {
    const out = assembleUserMessageContent({
      userMessage: '帮我看这张图',
      imageNote: '🖼️ 用户提供了 1 张图片',
    })
    // 只能有一个 <sf_user_message> 块（用户真实输入）
    const openTags = out.match(/<sf_user_message>/g) || []
    expect(openTags).toHaveLength(1)
    // imageNote 以纯文本出现，且不在 sf_user_message 标签内
    expect(out).toContain('🖼️ 用户提供了 1 张图片')
    expect(out).toMatch(/<\/sf_user_message>[\s\S]*🖼️ 用户提供了 1 张图片/)
  })
})
