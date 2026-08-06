/**
 * resolveBudgetProfileId 单元测试
 */
import { describe, it, expect } from 'vitest'
import type { AiProfile } from '@shared/types'
import { resolveBudgetProfileId, shouldSkipCachePathForVision } from '../vision-routing'

function profile(partial: Partial<AiProfile> & Pick<AiProfile, 'id' | 'name'>): AiProfile {
  return {
    apiUrl: 'https://example.com',
    apiKey: '',
    model: partial.model || partial.id,
    contextLength: partial.contextLength ?? 128000,
    ...partial,
  }
}

const deepseek = profile({ id: 'ds', name: 'DeepSeek V4 Flash', model: 'deepseek-v4-flash', contextLength: 1_000_000 })
const doubao = profile({
  id: 'db',
  name: 'Doubao Vision',
  model: 'doubao-vision',
  contextLength: 256_000,
  modelType: 'vision',
})
const deepseekWithVision = profile({
  id: 'ds',
  name: 'DeepSeek V4 Flash',
  model: 'deepseek-v4-flash',
  contextLength: 1_000_000,
  visionProfileId: 'db',
})

describe('resolveBudgetProfileId', () => {
  it('无图 → 返回主模型', () => {
    expect(resolveBudgetProfileId({
      mainProfileId: 'ds',
      activeProfileId: 'ds',
      profiles: [deepseekWithVision, doubao],
      autoVisionModel: true,
      hasImages: false,
    })).toBe('ds')
  })

  it('有图 + 关联视觉模型 → 返回视觉模型', () => {
    expect(resolveBudgetProfileId({
      mainProfileId: 'ds',
      activeProfileId: 'ds',
      profiles: [deepseekWithVision, doubao],
      autoVisionModel: true,
      hasImages: true,
    })).toBe('db')
  })

  it('autoVisionModel 关闭 → 即使有图也不切', () => {
    expect(resolveBudgetProfileId({
      mainProfileId: 'ds',
      activeProfileId: 'ds',
      profiles: [deepseekWithVision, doubao],
      autoVisionModel: false,
      hasImages: true,
    })).toBe('ds')
  })

  it('未配置 visionProfileId → 留在主模型', () => {
    expect(resolveBudgetProfileId({
      mainProfileId: 'ds',
      activeProfileId: 'ds',
      profiles: [deepseek, doubao],
      autoVisionModel: true,
      hasImages: true,
    })).toBe('ds')
  })

  it('主模型本身是 vision → 不二次切换', () => {
    expect(resolveBudgetProfileId({
      mainProfileId: 'db',
      activeProfileId: 'db',
      profiles: [doubao],
      autoVisionModel: true,
      hasImages: true,
    })).toBe('db')
  })

  it('visionProfileId 指向不存在的 profile → 回退主模型', () => {
    const broken = profile({
      id: 'ds',
      name: 'DeepSeek',
      visionProfileId: 'missing',
    })
    expect(resolveBudgetProfileId({
      mainProfileId: 'ds',
      activeProfileId: 'ds',
      profiles: [broken],
      autoVisionModel: true,
      hasImages: true,
    })).toBe('ds')
  })
})

describe('shouldSkipCachePathForVision', () => {
  const base = {
    mainProfileId: 'ds',
    activeProfileId: 'ds',
    profiles: [deepseekWithVision, doubao],
    autoVisionModel: true,
    hasImages: true,
    usingCachePath: true,
  }

  it('新图首投 + 无图前缀 + 跨模型路由 → 跳过 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      hasNewImagesThisTurn: true,
      prefixHasImages: false,
    })).toBe(true)
  })

  it('前缀已有图（视觉模型已接受过该前缀）→ 保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      hasNewImagesThisTurn: true,
      prefixHasImages: true,
    })).toBe(false)
  })

  it('纯文本续聊带图前缀（本轮无新图）→ 保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      hasNewImagesThisTurn: false,
      prefixHasImages: true,
    })).toBe(false)
  })

  it('无图会话（无新图、无前缀图）→ 不切模型，保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      hasImages: false,
      hasNewImagesThisTurn: false,
      prefixHasImages: false,
    })).toBe(false)
  })

  it('主模型本身是 vision（同 profile）→ 保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      mainProfileId: 'db',
      activeProfileId: 'db',
      profiles: [doubao],
      hasNewImagesThisTurn: true,
      prefixHasImages: false,
    })).toBe(false)
  })

  it('未配置 visionProfileId（留在主模型）→ 保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      profiles: [deepseek, doubao],
      hasNewImagesThisTurn: true,
      prefixHasImages: false,
    })).toBe(false)
  })

  it('非 cache path（usingCachePath=false）→ 不跳过', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      usingCachePath: false,
      hasNewImagesThisTurn: true,
      prefixHasImages: false,
    })).toBe(false)
  })

  it('autoVisionModel 关闭 + 新图首投 → 保持 cache', () => {
    expect(shouldSkipCachePathForVision({
      ...base,
      autoVisionModel: false,
      hasNewImagesThisTurn: true,
      prefixHasImages: false,
    })).toBe(false)
  })
})
