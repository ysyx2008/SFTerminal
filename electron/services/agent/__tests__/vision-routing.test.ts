/**
 * resolveBudgetProfileId 单元测试
 */
import { describe, it, expect } from 'vitest'
import type { AiProfile } from '@shared/types'
import { resolveBudgetProfileId } from '../vision-routing'

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
