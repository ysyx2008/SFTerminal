import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_IPC_FLUSH_CHARS,
  TERMINAL_IPC_FLUSH_MS,
  createTerminalDataCoalescer,
} from '../terminal-data-coalescer'

describe('createTerminalDataCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('小包先攒着，到点再一次下发', () => {
    const send = vi.fn()
    const coalescer = createTerminalDataCoalescer(send)

    coalescer.push('a')
    coalescer.push('b')
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TERMINAL_IPC_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('ab')
  })

  it('攒到上限立刻下发，不等定时器', () => {
    const send = vi.fn()
    const coalescer = createTerminalDataCoalescer(send)
    const first = 'x'.repeat(TERMINAL_IPC_FLUSH_CHARS - 1)
    coalescer.push(first)
    expect(send).not.toHaveBeenCalled()

    coalescer.push('yz')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(first + 'yz')
  })

  it('dispose 把还没发出去的尾巴立刻送走', () => {
    const send = vi.fn()
    const coalescer = createTerminalDataCoalescer(send)
    coalescer.push('tail')
    coalescer.dispose()
    expect(send).toHaveBeenCalledWith('tail')

    coalescer.push('ignored')
    vi.advanceTimersByTime(TERMINAL_IPC_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('空串不占一次下发', () => {
    const send = vi.fn()
    const coalescer = createTerminalDataCoalescer(send)
    coalescer.push('')
    vi.advanceTimersByTime(TERMINAL_IPC_FLUSH_MS)
    expect(send).not.toHaveBeenCalled()
  })

  it('下发抛错不影响后续包', () => {
    const send = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('sender gone')
      })
      .mockImplementation(() => {})
    const coalescer = createTerminalDataCoalescer(send)
    coalescer.push('first')
    vi.advanceTimersByTime(TERMINAL_IPC_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    coalescer.push('second')
    vi.advanceTimersByTime(TERMINAL_IPC_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('second')
  })
})
