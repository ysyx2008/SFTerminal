import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {}
  }),
  ConfigService: class {}
}))

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => ({
    logRequestStart: () => {},
    logResponseChunk: () => {},
    logResponseDone: () => {},
    logResponseError: () => {}
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { isRetryableError } from '../ai.service'

describe('isRetryableError', () => {
  it('matches Node system error codes via err.code', () => {
    expect(isRetryableError({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true)
    expect(isRetryableError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe(true)
    expect(isRetryableError({ code: 'EPROTO', message: 'write EPROTO' })).toBe(true)
  })

  it('retries TLS handshake disconnect when only err.code is ECONNRESET', () => {
    // VPN/代理切换时 Node 常见形态：message 不含错误码字样
    expect(isRetryableError({
      code: 'ECONNRESET',
      message: 'Client network socket disconnected before secure TLS connection was established',
    })).toBe(true)
  })

  it('does not retry TLS disconnect message without a retryable code', () => {
    expect(isRetryableError({
      message: 'Client network socket disconnected before secure TLS connection was established',
    })).toBe(false)
  })

  it('still matches codes embedded in message strings', () => {
    expect(isRetryableError('getaddrinfo ENOTFOUND api.example.com')).toBe(true)
    expect(isRetryableError('ETIMEDOUT')).toBe(true)
    expect(isRetryableError('socket hang up')).toBe(true)
  })

  it('does not retry permanent client errors', () => {
    expect(isRetryableError({ code: 'ERR_INVALID_URL', message: 'Invalid URL' })).toBe(false)
    expect(isRetryableError('invalid api key')).toBe(false)
  })
})
