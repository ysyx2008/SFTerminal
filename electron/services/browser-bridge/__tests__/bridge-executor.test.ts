import { describe, expect, it } from 'vitest'
import {
  isAttachLaunch,
  requiresPlaywrightLaunch,
  shouldPreferAttach,
  wantsExplicitLaunch,
} from '../../agent/skills/browser/bridge-executor'

describe('bridge-executor helpers', () => {
  it('isAttachLaunch detects attach flag', () => {
    expect(isAttachLaunch({ attach: true })).toBe(true)
    expect(isAttachLaunch({ mode: 'attach' })).toBe(true)
    expect(isAttachLaunch({ mode: 'launch' })).toBe(false)
    expect(isAttachLaunch({})).toBe(false)
  })

  it('shouldPreferAttach prefers attach when bridge connected', () => {
    expect(shouldPreferAttach({}, true)).toBe(true)
    expect(shouldPreferAttach({}, false)).toBe(false)
    expect(shouldPreferAttach({ mode: 'launch' }, true)).toBe(false)
    expect(shouldPreferAttach({ attach: false }, true)).toBe(false)
    expect(shouldPreferAttach({ headless: true }, true)).toBe(false)
    expect(shouldPreferAttach({ profile: 'github' }, true)).toBe(false)
    expect(shouldPreferAttach({ attach: true }, false)).toBe(true)
  })

  it('wantsExplicitLaunch and requiresPlaywrightLaunch', () => {
    expect(wantsExplicitLaunch({ mode: 'launch' })).toBe(true)
    expect(wantsExplicitLaunch({ attach: false })).toBe(true)
    expect(requiresPlaywrightLaunch({ headless: true })).toBe(true)
    expect(requiresPlaywrightLaunch({ profile: 'x' })).toBe(true)
  })
})
