import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS,
  MIN_CONTEXT_KNOWLEDGE_MAX_CHARS,
  MAX_CONTEXT_KNOWLEDGE_MAX_CHARS,
  clampContextKnowledgeMaxChars,
} from '../context-knowledge-budget'

describe('clampContextKnowledgeMaxChars', () => {
  it('合法数字原样取整', () => {
    expect(clampContextKnowledgeMaxChars(8000)).toBe(8000)
    expect(clampContextKnowledgeMaxChars(8000.4)).toBe(8000)
  })

  it('低于下限提到一千', () => {
    expect(clampContextKnowledgeMaxChars(100)).toBe(MIN_CONTEXT_KNOWLEDGE_MAX_CHARS)
  })

  it('高于上限压到两万', () => {
    expect(clampContextKnowledgeMaxChars(99999)).toBe(MAX_CONTEXT_KNOWLEDGE_MAX_CHARS)
  })

  it('不合法回到默认五千', () => {
    expect(clampContextKnowledgeMaxChars(undefined)).toBe(DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS)
    expect(clampContextKnowledgeMaxChars('5000')).toBe(DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS)
    expect(clampContextKnowledgeMaxChars(NaN)).toBe(DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS)
  })
})
