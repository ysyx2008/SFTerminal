import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AiProfile } from '@shared/types'
import {
  addAiProfileConfig,
  deleteAiProfileConfig,
  formatAiProfilesDetail,
  formatAiProfilesSummary,
  updateAiProfileConfig,
  type AiProfileStore,
} from '../ai-profiles'

function makeStore(initial: AiProfile[] = [], active = ''): AiProfileStore {
  let profiles = [...initial]
  let activeId = active
  return {
    getAiProfiles: () => profiles,
    addAiProfile: (p) => { profiles = [...profiles, p] },
    updateAiProfile: (p) => {
      profiles = profiles.map(x => x.id === p.id ? p : x)
    },
    deleteAiProfile: (id) => { profiles = profiles.filter(p => p.id !== id) },
    getActiveAiProfile: () => activeId,
    setActiveAiProfile: (id) => { activeId = id },
    setAiProfiles: (next) => { profiles = [...next] },
  }
}

const sample = (over: Partial<AiProfile> = {}): AiProfile => ({
  id: 'p1',
  name: 'DeepSeek',
  apiUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: 'sk-secret-should-not-leak',
  model: 'deepseek-chat',
  modelType: 'general',
  apiFormat: 'auto',
  contextLength: 128000,
  ...over,
})

describe('formatAiProfiles', () => {
  it('lists name, model, url, key status and default; never echoes the key', () => {
    const store = makeStore([sample()], 'p1')
    const summary = formatAiProfilesSummary(store)
    expect(summary).toContain('DeepSeek')
    expect(summary).toContain('deepseek-chat')
    expect(summary).toContain('https://api.deepseek.com/v1/chat/completions')
    expect(summary).toContain('Key 已配置')
    expect(summary).toContain('当前默认')
    expect(summary).not.toContain('sk-secret')

    const detail = formatAiProfilesDetail(store)
    expect(detail).toContain('DeepSeek')
    expect(detail).toContain('Key 已配置')
    expect(detail).not.toContain('sk-secret')
  })

  it('empty list tells agent to use add, not just "0 项"', () => {
    const store = makeStore()
    expect(formatAiProfilesSummary(store)).toContain('config_ai_profile_add')
    expect(formatAiProfilesSummary(store)).not.toMatch(/\[0 项\]/)
  })
})

describe('addAiProfileConfig', () => {
  it('requires name, apiUrl, model, apiKey', async () => {
    const r = await addAiProfileConfig(makeStore(), { name: 'x' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/缺少必填参数/)
  })

  it('rejects invalid url', async () => {
    const r = await addAiProfileConfig(makeStore(), {
      name: 'x', apiUrl: 'not-a-url', model: 'm', apiKey: 'k',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/合法地址/)
  })

  it('first profile becomes default; second does not steal it', async () => {
    const store = makeStore()
    const a = await addAiProfileConfig(store, {
      name: 'A',
      apiUrl: 'https://a.example/v1/chat/completions',
      model: 'a',
      apiKey: 'ka',
      id: 'id-a',
    })
    expect(a.success).toBe(true)
    expect(store.getActiveAiProfile()).toBe('id-a')

    const b = await addAiProfileConfig(store, {
      name: 'B',
      apiUrl: 'https://b.example/v1/chat/completions',
      model: 'b',
      apiKey: 'kb',
      id: 'id-b',
    })
    expect(b.success).toBe(true)
    expect(store.getActiveAiProfile()).toBe('id-a')
    expect(store.getAiProfiles()).toHaveLength(2)
  })

  it('rejects linking a non-vision profile as visionProfileId', async () => {
    const store = makeStore([sample({ id: 'gen', modelType: 'general' })])
    const r = await addAiProfileConfig(store, {
      name: 'X',
      apiUrl: 'https://x.example/v1/chat/completions',
      model: 'x',
      apiKey: 'k',
      visionProfileId: 'gen',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/不是视觉模型/)
  })

  it('setActive=true makes a later profile the default', async () => {
    const store = makeStore([sample()], 'p1')
    const r = await addAiProfileConfig(store, {
      name: 'B',
      apiUrl: 'https://b.example/v1/chat/completions',
      model: 'b',
      apiKey: 'kb',
      id: 'id-b',
      setActive: true,
    })
    expect(r.success).toBe(true)
    expect(store.getActiveAiProfile()).toBe('id-b')
  })

  it('accepts setActive as the string "true"', async () => {
    const store = makeStore([sample()], 'p1')
    const r = await addAiProfileConfig(store, {
      name: 'B',
      apiUrl: 'https://b.example/v1/chat/completions',
      model: 'b',
      apiKey: 'kb',
      id: 'id-b',
      setActive: 'true',
    })
    expect(r.success).toBe(true)
    expect(store.getActiveAiProfile()).toBe('id-b')
  })

  it('saves even when connection test fails, and does not echo the key', async () => {
    const store = makeStore()
    const testFn = vi.fn().mockResolvedValue({ success: false, message: '401' })
    const r = await addAiProfileConfig(store, {
      name: 'X',
      apiUrl: 'https://x.example/v1/chat/completions',
      model: 'x',
      apiKey: 'sk-hidden',
    }, testFn)
    expect(r.success).toBe(true)
    expect(store.getAiProfiles()).toHaveLength(1)
    expect(r.output).toMatch(/连接测试失败/)
    expect(r.output).not.toContain('sk-hidden')
  })
})

describe('update / delete', () => {
  it('partial update keeps the old key when apiKey is omitted', async () => {
    const store = makeStore([sample()], 'p1')
    const r = await updateAiProfileConfig(store, { profileId: 'p1', name: 'DS' })
    expect(r.success).toBe(true)
    expect(store.getAiProfiles()[0].name).toBe('DS')
    expect(store.getAiProfiles()[0].apiKey).toBe('sk-secret-should-not-leak')
    expect(r.output).not.toContain('sk-secret')
  })

  it('deleting the default switches to the first remaining', () => {
    const store = makeStore([
      sample({ id: 'p1', name: 'A' }),
      sample({ id: 'p2', name: 'B', apiKey: 'other' }),
    ], 'p1')
    const r = deleteAiProfileConfig(store, { profileId: 'p1' })
    expect(r.success).toBe(true)
    expect(store.getAiProfiles().map(p => p.id)).toEqual(['p2'])
    expect(store.getActiveAiProfile()).toBe('p2')
  })

  it('clears visionProfileId refs on other profiles', () => {
    const store = makeStore([
      sample({ id: 'vision', name: 'V', modelType: 'vision' }),
      sample({ id: 'main', name: 'M', visionProfileId: 'vision' }),
    ], 'main')
    deleteAiProfileConfig(store, { profileId: 'vision' })
    expect(store.getAiProfiles()[0].visionProfileId).toBeUndefined()
  })
})
