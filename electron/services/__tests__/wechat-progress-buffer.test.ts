import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WechatProgressBuffer,
  WECHAT_PROGRESS_FLUSH_INTERVAL_MS,
  formatWechatProgressDigest,
} from '../im/wechat/progress-buffer'

describe('formatWechatProgressDigest', () => {
  it('joins tool lines with bullet prefix', () => {
    expect(
      formatWechatProgressDigest([
        { kind: 'tool', text: '🔧 read_file' },
        { kind: 'tool', text: '❌ calendar 失败' },
      ]),
    ).toBe('· 🔧 read_file\n· ❌ calendar 失败')
  })

  it('renders body entries without bullet prefix', () => {
    expect(
      formatWechatProgressDigest([
        { kind: 'tool', text: '🔧 read_file' },
        { kind: 'body', text: '我来查一下' },
      ]),
    ).toBe('· 🔧 read_file\n我来查一下')
  })

  it('returns empty string for no entries', () => {
    expect(formatWechatProgressDigest([])).toBe('')
  })
})

describe('WechatProgressBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes accumulated tool lines after interval', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('🔧 a')
    buffer.push('🔧 b')
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
    await buffer.flush()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('· 🔧 a\n· 🔧 b')
  })

  it('dedupes consecutive identical tool lines', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('🔧 same')
    buffer.push('🔧 same')
    await buffer.flush()

    expect(send.mock.calls[0][0]).toBe('· 🔧 same')
  })

  it('flush immediately when max tool lines reached', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = new WechatProgressBuffer(send, { maxLines: 3 })

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
    const buffer = new WechatProgressBuffer(send, {})

    buffer.push('pending')
    await buffer.dispose()

    expect(send).toHaveBeenCalledTimes(1)
    buffer.push('ignored')
    await buffer.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  describe('body boundary-aware flush', () => {
    it('pushBody flushes existing tool progress before enqueuing body', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.push('🔧 tool-a')
      buffer.push('🔧 tool-b')
      buffer.pushBody('我来查一下')

      // body 入队前，已有工具进度应先 flush 出去（flush 是异步链，等 microtask）
      await Promise.resolve()
      await Promise.resolve()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('· 🔧 tool-a\n· 🔧 tool-b')

      // body 还在 buffer 里，没发
      expect(send).toHaveBeenCalledTimes(1)

      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1][0]).toBe('我来查一下')
    })

    it('pushBody schedules a flush timer — body is sent after interval if no follow-up', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('正文')
      // body 入队后启动了 25s 定时器，没来工具通知的话到点自动切出
      expect(send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('正文')
    })

    it('body followed by tool progress within interval merges into one digest', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      buffer.pushBody('我来查一下')
      // body 入队后启动了定时器；定时器未 fire 前来了工具通知，并入同一 digest
      buffer.push('🔧 read_file')

      expect(send).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(WECHAT_PROGRESS_FLUSH_INTERVAL_MS)
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('我来查一下\n· 🔧 read_file')
    })

    it('body does not count toward maxLines', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, { maxLines: 2 })

      buffer.pushBody('正文一')
      buffer.pushBody('正文二')
      buffer.pushBody('正文三')
      // 三个 body 都不该触发 maxLines flush
      expect(send).not.toHaveBeenCalled()

      await buffer.flush()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('正文一\n正文二\n正文三')
    })

    it('consecutive identical body lines are NOT deduped (each is a distinct message)', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      // body 去重仅对工具进度生效，正文每段都是独立消息，不去重
      buffer.pushBody('我来查一下')
      buffer.pushBody('我来查一下')
      await buffer.flush()

      expect(send.mock.calls[0][0]).toBe('我来查一下\n我来查一下')
    })

    it('flushProgress (flush) on task end sends body even without follow-up tool', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const buffer = new WechatProgressBuffer(send, {})

      // 模拟 ReAct 结束：body 后没来工具通知，任务结束 flushProgress 切走
      buffer.pushBody('任务完成的最终正文')
      await buffer.flush()

      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0]).toBe('任务完成的最终正文')
    })
  })
})
