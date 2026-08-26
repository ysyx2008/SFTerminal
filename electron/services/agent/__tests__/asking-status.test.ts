import { describe, expect, it } from 'vitest'
import { isAskingSettled } from '@shared/types/agent'

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
