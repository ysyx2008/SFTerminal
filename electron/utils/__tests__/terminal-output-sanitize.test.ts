import { describe, expect, it } from 'vitest'
import {
  CONSECUTIVE_NUL_COLLAPSE_MIN,
  TERMINAL_CAPTURE_MAX_CHARS,
  appendCappedTerminalOutput,
  collapseConsecutiveNuls,
} from '../terminal-output-sanitize'

describe('collapseConsecutiveNuls', () => {
  it('短于阈值的 NUL 原样保留', () => {
    const short = 'a' + '\0'.repeat(CONSECUTIVE_NUL_COLLAPSE_MIN - 1) + 'b'
    expect(collapseConsecutiveNuls(short)).toBe(short)
  })

  it('连续很长的 NUL 丢掉，空格换行不动', () => {
    const text = 'head\n  \t' + '\0'.repeat(CONSECUTIVE_NUL_COLLAPSE_MIN) + 'tail'
    expect(collapseConsecutiveNuls(text)).toBe('head\n  \ttail')
  })

  it('没有 NUL 时不改动', () => {
    expect(collapseConsecutiveNuls('hello world')).toBe('hello world')
  })
})

describe('appendCappedTerminalOutput', () => {
  it('大段空字节不撑爆环缓', () => {
    const next = appendCappedTerminalOutput('', '\0'.repeat(2_000_000), 1000)
    expect(next).toBe('')
  })

  it('超上限只留尾巴', () => {
    const next = appendCappedTerminalOutput('aaaa', 'bbbbcccc', 8)
    expect(next.length).toBe(8)
    expect(next.endsWith('cccc')).toBe(true)
  })

  it('默认上限与常量一致', () => {
    const next = appendCappedTerminalOutput('x'.repeat(10), 'y'.repeat(TERMINAL_CAPTURE_MAX_CHARS))
    expect(next.length).toBe(TERMINAL_CAPTURE_MAX_CHARS)
    expect(next.endsWith('y')).toBe(true)
  })
})
