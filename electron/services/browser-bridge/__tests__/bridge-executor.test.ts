import { describe, expect, it } from 'vitest'
import { isAttachLaunch } from '../../agent/skills/browser/bridge-executor'

describe('bridge-executor helpers', () => {
  it('isAttachLaunch detects attach flag', () => {
    expect(isAttachLaunch({ attach: true })).toBe(true)
    expect(isAttachLaunch({ mode: 'attach' })).toBe(true)
    expect(isAttachLaunch({ mode: 'launch' })).toBe(false)
    expect(isAttachLaunch({})).toBe(false)
  })
})
