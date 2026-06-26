import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WechatProgressBuffer,
  WECHAT_PROGRESS_FLUSH_INTERVAL_MS,
  formatWechatProgressDigest,
} from '../im/wechat/progress-buffer'

describe('formatWechatProgressDigest', () => {
  it('joins lines with bullet prefix and header', () => {
    expect(formatWechatProgressDigest(['🔧 read_file', '❌ calendar 失败'], '⏳ 进行中…')).toBe(
      '⏳ 进行中…\n· 🔧 read_file\n· ❌ calendar 失败',
    )
  })

  it('returns empty string for no lines', () => {
    expect(formatWechatProgressDigest([], '⏳')).toBe('')
  })
})

describe('WechatProgressBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes accumulated lines after interval', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { header: '⏳ H' })

    buffer.push('🔧 a')
    buffer.push('🔧 b')
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
    await buffer.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('⏳ H\n· 🔧 a\n· 🔧 b')
  })

  it('dedupes consecutive identical lines', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { header: '⏳ H' })

    buffer.push('🔧 same')
    buffer.push('🔧 same')
    await buffer.flush()

    expect(send.mock.calls[0][0]).toBe('⏳ H\n· 🔧 same')
  })

  it('flush immediately when max lines reached', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { header: '⏳ H', maxLines: 3 })

    buffer.push('1')
    buffer.push('2')
    buffer.push('3')
    await buffer.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toContain('· 1')
    expect(send.mock.calls[0][0]).toContain('· 3')
  })

  it('dispose flushes remaining without scheduling another timer', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { header: '⏳ H' })

    buffer.push('pending')
    await buffer.dispose()

    expect(send).toHaveBeenCalledTimes(1)
    buffer.push('ignored')
    await buffer.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
