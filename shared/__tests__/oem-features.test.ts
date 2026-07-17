import { describe, expect, it } from 'vitest'
import { isOemFeatureEnabled, OEM_FEATURE_DEFAULTS } from '../oem-features'
import type { OemConfig } from '../oem-types'

function baseConfig(features: Partial<OemConfig['features']> = {}): OemConfig {
  return {
    brand: {
      name: { zh: '测', en: 'T' },
      logo: '/x.png',
      copyright: { zh: '©', en: '©' }
    },
    features: {
      ...OEM_FEATURE_DEFAULTS,
      ...features
    }
  }
}

describe('isOemFeatureEnabled', () => {
  it('defaults: secretary features on, sso off', () => {
    expect(OEM_FEATURE_DEFAULTS.awaken).toBe(true)
    expect(OEM_FEATURE_DEFAULTS.bond).toBe(true)
    expect(OEM_FEATURE_DEFAULTS.localTerminal).toBe(true)
    expect(OEM_FEATURE_DEFAULTS.sso).toBe(false)
  })

  it('reads explicit false', () => {
    const cfg = baseConfig({ awaken: false, localTerminal: false, bond: false })
    expect(isOemFeatureEnabled('awaken', cfg)).toBe(false)
    expect(isOemFeatureEnabled('localTerminal', cfg)).toBe(false)
    expect(isOemFeatureEnabled('bond', cfg)).toBe(false)
    expect(isOemFeatureEnabled('assistantWorkbench', cfg)).toBe(true)
  })

  it('falls back to defaults when feature field missing', () => {
    const cfg = baseConfig()
    // 模拟旧配置缺字段
    delete (cfg.features as { sso?: boolean }).sso
    delete (cfg.features as { awaken?: boolean }).awaken
    delete (cfg.features as { bond?: boolean }).bond
    expect(isOemFeatureEnabled('sso', cfg)).toBe(false)
    expect(isOemFeatureEnabled('awaken', cfg)).toBe(true)
    expect(isOemFeatureEnabled('bond', cfg)).toBe(true)
  })
})
