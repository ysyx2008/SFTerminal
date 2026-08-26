import { describe, expect, it } from 'vitest'
import { clampAskUserTimeout, isAskingSettled } from '@shared/types/agent'

describe('isAskingSettled', () => {
  it('treats received, timeout, and cancelled as settled', () => {
    expect(isAskingSettled('received')).toBe(true)
    expect(isAskingSettled('timeout')).toBe(true)
    expect(isAskingSettled('cancelled')).toBe(true)
  })

  it('treats waiting and missing status as not settled', () => {
    expect(isAskingSettled('waiting')).toBe(false)
    expect(isAskingSettled(undefined)).toBe(false)
  })
})

describe('clampAskUserTimeout', () => {
  it('keeps the value the agent set', () => {
    expect(clampAskUserTimeout(5)).toBe(5)
    expect(clampAskUserTimeout(120)).toBe(120)
    expect(clampAskUserTimeout(600)).toBe(600)
  })

  it('defaults when missing and clamps extremes', () => {
    expect(clampAskUserTimeout(undefined)).toBe(120)
    expect(clampAskUserTimeout(0)).toBe(1)
    expect(clampAskUserTimeout(0.4)).toBe(1)
    expect(clampAskUserTimeout(9999)).toBe(600)
  })
})
