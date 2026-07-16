import { describe, it, expect } from 'vitest'
import { resolveAiProfile } from '../ai.service'
import type { AiProfile } from '@shared/types'

function profile(id: string, name = id): AiProfile {
  return {
    id,
    name,
    apiUrl: 'https://example.com/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
    contextLength: 8192,
    maxOutputTokens: 2048,
  }
}

describe('resolveAiProfile', () => {
  it('列表为空返回 null', () => {
    expect(resolveAiProfile([], 'a', 'a')).toEqual({ profile: null })
  })

  it('指定 id 命中时直接返回，无 fallback', () => {
    const profiles = [profile('a', 'A'), profile('b', 'B')]
    const r = resolveAiProfile(profiles, 'a', 'b')
    expect(r.profile?.id).toBe('b')
    expect(r.fallback).toBeUndefined()
  })

  it('指定 id 未命中时回退 active，并带 fallback', () => {
    const profiles = [profile('a', 'Alpha'), profile('b', 'Beta')]
    const r = resolveAiProfile(profiles, 'a', 'missing')
    expect(r.profile?.id).toBe('a')
    expect(r.fallback).toEqual({
      requestedId: 'missing',
      usedId: 'a',
      usedName: 'Alpha',
    })
  })

  it('指定 id 与 active 均未命中时回退第一个', () => {
    const profiles = [profile('a', 'Alpha'), profile('b', 'Beta')]
    const r = resolveAiProfile(profiles, 'gone', 'also-gone')
    expect(r.profile?.id).toBe('a')
    expect(r.fallback).toEqual({
      requestedId: 'also-gone',
      usedId: 'a',
      usedName: 'Alpha',
    })
  })

  it('未指定 id 时用 active；active 失效则回退第一个并通知', () => {
    const profiles = [profile('a', 'Alpha'), profile('b', 'Beta')]
    const hit = resolveAiProfile(profiles, 'b')
    expect(hit.profile?.id).toBe('b')
    expect(hit.fallback).toBeUndefined()

    const miss = resolveAiProfile(profiles, 'gone')
    expect(miss.profile?.id).toBe('a')
    expect(miss.fallback).toEqual({
      requestedId: 'gone',
      usedId: 'a',
      usedName: 'Alpha',
    })
  })

  it('activeId 为空字符串且未指定 requestedId 时用第一个，不发 fallback', () => {
    const profiles = [profile('a', 'Alpha')]
    const r = resolveAiProfile(profiles, '')
    expect(r.profile?.id).toBe('a')
    expect(r.fallback).toBeUndefined()
  })

  it('仅一个 profile 时 requestedId 未命中仍回退到它', () => {
    const profiles = [profile('only', 'Only')]
    const r = resolveAiProfile(profiles, 'only', 'missing')
    expect(r.profile?.id).toBe('only')
    expect(r.fallback?.usedName).toBe('Only')
  })
})
