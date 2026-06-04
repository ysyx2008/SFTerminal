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
})
