import { describe, expect, it } from 'vitest'
import { oemConfig } from '../oem-runtime'
import { OEM_FEATURE_DEFAULTS } from '../oem-types'

describe('oem-runtime', () => {
  it('无 oem.config.ts 时使用开源默认（秘书能力开、sso 关）', () => {
    expect(oemConfig.brand.name.zh).toBe('旗鱼')
    expect(oemConfig.brand.name.en).toBe('SailFish')
    expect(oemConfig.features.awaken).toBe(OEM_FEATURE_DEFAULTS.awaken)
    expect(oemConfig.features.sso).toBe(false)
  })
})
