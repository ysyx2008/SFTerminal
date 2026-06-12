import { describe, expect, it } from 'vitest'
import {
  attachTargetLabel,
  inferBrowserFromOrigin,
  isCommand,
  isCommandResult,
  normalizeAttachTargetInput,
  parseGatewayLines,
  serializeGatewayLine,
} from '../protocol'

describe('browser-bridge protocol', () => {
  it('parseGatewayLines splits newline-delimited JSON', () => {
    const input = '{"a":1}\n{"b":2}\npartial'
    const { messages, rest } = parseGatewayLines(input)
    expect(messages).toEqual([{ a: 1 }, { b: 2 }])
    expect(rest).toBe('partial')
  })

  it('serializeGatewayLine appends newline', () => {
    expect(serializeGatewayLine({ x: 1 })).toBe('{"x":1}\n')
  })

  it('isCommand detects command envelope', () => {
    expect(isCommand({ id: '1', action: 'ping' })).toBe(true)
    expect(isCommand({ id: '1' })).toBe(false)
  })

  it('isCommandResult detects result envelope', () => {
    expect(isCommandResult({ id: '1', success: true })).toBe(true)
    expect(isCommandResult({ id: '1', success: false, error: 'x' })).toBe(true)
  })

  it('inferBrowserFromOrigin detects firefox', () => {
    expect(inferBrowserFromOrigin('moz-extension://abc/')).toBe('firefox')
    expect(inferBrowserFromOrigin('chrome-extension://abc/')).toBe('chrome')
  })

  it('normalizeAttachTargetInput maps browser aliases', () => {
    expect(normalizeAttachTargetInput(undefined)).toBe('auto')
    expect(normalizeAttachTargetInput('auto')).toBe('auto')
    expect(normalizeAttachTargetInput('firefox')).toBe('firefox')
    expect(normalizeAttachTargetInput('chrome')).toBe('chromium')
    expect(normalizeAttachTargetInput('edge')).toBe('chromium')
    expect(normalizeAttachTargetInput('chromium')).toBe('chromium')
  })

  it('attachTargetLabel returns user-facing names', () => {
    expect(attachTargetLabel('firefox')).toContain('Firefox')
    expect(attachTargetLabel('chromium')).toContain('Chromium')
  })
})
