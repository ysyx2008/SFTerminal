import { describe, it, expect } from 'vitest'
import { parseModelListEntry } from '../ai.service'

describe('parseModelListEntry', () => {
  it('无 id 则丢弃', () => {
    expect(parseModelListEntry({})).toBeNull()
    expect(parseModelListEntry({ id: '  ' })).toBeNull()
  })

  it('只认结构化视觉字段', () => {
    expect(parseModelListEntry({ id: 'm', input_modalities: ['image', 'text'] })?.supportsVision).toBe(true)
    expect(parseModelListEntry({ id: 'm', capabilities: { vision: true } })?.supportsVision).toBe(true)
    expect(parseModelListEntry({ id: 'm', type: 'multimodal' })?.supportsVision).toBe(true)
    expect(parseModelListEntry({ id: 'm' })?.supportsVision).toBe(false)
  })

  it('读上下文长度的常见字段', () => {
    expect(parseModelListEntry({ id: 'm', context_length: 1_000_000 })?.contextLength).toBe(1_000_000)
    expect(parseModelListEntry({ id: 'm', context_window: 256_000 })?.contextLength).toBe(256_000)
    expect(parseModelListEntry({ id: 'm', max_input_tokens: 200_000 })?.contextLength).toBe(200_000)
  })

  it('读明确的输出上限字段', () => {
    expect(parseModelListEntry({ id: 'm', max_output_tokens: 384_000 })?.maxOutputTokens).toBe(384_000)
    expect(parseModelListEntry({ id: 'm', max_completion_tokens: 65_536 })?.maxOutputTokens).toBe(65_536)
    expect(parseModelListEntry({ id: 'm', output_token_limit: 128_000 })?.maxOutputTokens).toBe(128_000)
    expect(parseModelListEntry({ id: 'm', outputTokenLimit: 64_000 })?.maxOutputTokens).toBe(64_000)
    expect(parseModelListEntry({
      id: 'm',
      top_provider: { max_completion_tokens: 32_768 },
    })?.maxOutputTokens).toBe(32_768)
  })

  it('Anthropic：max_tokens 小于上下文时当作输出上限', () => {
    const parsed = parseModelListEntry({
      id: 'claude-opus-4-7',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
    })
    expect(parsed?.contextLength).toBe(1_000_000)
    expect(parsed?.maxOutputTokens).toBe(128_000)
  })

  it('max_tokens 等于上下文时不当作输出上限', () => {
    const parsed = parseModelListEntry({
      id: 'm',
      context_length: 1_000_000,
      max_tokens: 1_000_000,
    })
    expect(parsed?.contextLength).toBe(1_000_000)
    expect(parsed?.maxOutputTokens).toBeUndefined()
  })

  it('只有 max_tokens、没有上下文时不当作输出上限', () => {
    expect(parseModelListEntry({ id: 'm', max_tokens: 200_000 })?.maxOutputTokens).toBeUndefined()
  })

  it('明确的输出字段优先于 max_tokens', () => {
    const parsed = parseModelListEntry({
      id: 'm',
      max_tokens: 8_192,
      max_output_tokens: 384_000,
    })
    expect(parsed?.maxOutputTokens).toBe(384_000)
  })
})
