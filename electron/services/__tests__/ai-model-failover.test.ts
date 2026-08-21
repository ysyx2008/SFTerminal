import { describe, it, expect } from 'vitest'
import { classifyFailoverTrigger, listFailoverCandidates } from '../ai-model-failover'

function profile(id: string) {
  return { id, name: id }
}

describe('listFailoverCandidates', () => {
  it('只有一个配置时没有下一个', () => {
    expect(listFailoverCandidates([profile('a')], 'a')).toEqual([])
  })

  it('从当前这条后面开始，再到列表开头', () => {
    const profiles = [profile('a'), profile('b'), profile('c')]
    expect(listFailoverCandidates(profiles, 'b').map(p => p.id)).toEqual(['c', 'a'])
    expect(listFailoverCandidates(profiles, 'c').map(p => p.id)).toEqual(['a', 'b'])
    expect(listFailoverCandidates(profiles, 'a').map(p => p.id)).toEqual(['b', 'c'])
  })

  it('跳过已经试过的', () => {
    const profiles = [profile('a'), profile('b'), profile('c')]
    expect(listFailoverCandidates(profiles, 'a', new Set(['b'])).map(p => p.id)).toEqual(['c'])
  })

  it('当前 id 不在列表里时从第一个开始，仍排除已试过的', () => {
    const profiles = [profile('a'), profile('b')]
    expect(listFailoverCandidates(profiles, 'gone', new Set(['a'])).map(p => p.id)).toEqual(['b'])
  })

  it('跳过上下文窗口比当前更小的', () => {
    const profiles = [
      { id: 'big', contextLength: 256000 },
      { id: 'small', contextLength: 32000 },
      { id: 'same', contextLength: 256000 },
    ]
    expect(listFailoverCandidates(profiles, 'big', new Set(), 256000).map(p => p.id)).toEqual(['same'])
  })
})

describe('classifyFailoverTrigger', () => {
  it('重试用尽才换', () => {
    expect(classifyFailoverTrigger({ retriesExhausted: true })).toBe('retries_exhausted')
  })

  it('按协议码判断模型不存在 / 过载 / 额度', () => {
    expect(classifyFailoverTrigger({ apiErrorCode: 'model_not_found' })).toBe('model_not_found')
    expect(classifyFailoverTrigger({ apiErrorCode: 'not_found_error' })).toBe('model_not_found')
    expect(classifyFailoverTrigger({ apiErrorCode: 'overloaded_error' })).toBe('overloaded')
    expect(classifyFailoverTrigger({ apiErrorCode: 'insufficient_quota' })).toBe('insufficient_quota')
  })

  it('按 HTTP 状态判断，不用错误文案', () => {
    expect(classifyFailoverTrigger({ statusCode: 404 })).toBe('model_not_found')
    expect(classifyFailoverTrigger({ statusCode: 402 })).toBe('insufficient_quota')
    expect(classifyFailoverTrigger({ statusCode: 503 })).toBe('overloaded')
    expect(classifyFailoverTrigger({ statusCode: 529 })).toBe('overloaded')
  })

  it('鉴权、权限、内容违规、对话超长不换', () => {
    expect(classifyFailoverTrigger({ statusCode: 401, apiErrorCode: 'invalid_api_key' })).toBeNull()
    expect(classifyFailoverTrigger({ statusCode: 403, apiErrorCode: 'permission_denied' })).toBeNull()
    expect(classifyFailoverTrigger({ apiErrorCode: 'content_filter' })).toBeNull()
    expect(classifyFailoverTrigger({ apiErrorCode: 'context_length_exceeded' })).toBeNull()
    expect(classifyFailoverTrigger({ statusCode: 400 })).toBeNull()
  })
})
