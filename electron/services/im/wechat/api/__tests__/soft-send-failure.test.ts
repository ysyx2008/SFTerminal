import { describe, expect, it } from 'vitest'
import { isWeixinSoftSendFailure } from '../api'

describe('isWeixinSoftSendFailure', () => {
  it('treats ret=-2 as soft failure', () => {
    expect(isWeixinSoftSendFailure({ ret: -2, errmsg: 'prepare failed' })).toBe(true)
  })

  it('treats errcode=-2 as soft failure', () => {
    expect(isWeixinSoftSendFailure({ errcode: -2, errmsg: 'unknown' })).toBe(true)
  })

  it('does not treat other codes as soft failure', () => {
    expect(isWeixinSoftSendFailure({ ret: 0 })).toBe(false)
    expect(isWeixinSoftSendFailure({ ret: -14, errmsg: 'session expired' })).toBe(false)
    expect(isWeixinSoftSendFailure({})).toBe(false)
  })
})
