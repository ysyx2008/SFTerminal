import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 调用会被 hoist 到文件顶部，引用的变量必须用 vi.hoisted。
const mocks = vi.hoisted(() => {
  class MockStreamingMarkdownFilter {
    feed = vi.fn((s: string) => s)
    flush = vi.fn(() => '')
  }
  return {
    sendMessageWeixin: vi.fn(),
    sendWeixinMediaFile: vi.fn(),
    vendoredGetUpdates: vi.fn(),
    apiGetFetch: vi.fn(),
    sendTyping: vi.fn(),
    getConfig: vi.fn(),
    getForUser: vi.fn(),
    invalidateUser: vi.fn(),
    pauseSession: vi.fn(),
    assertSessionActive: vi.fn(),
    StreamingMarkdownFilter: MockStreamingMarkdownFilter,
  }
})
const sendMessageWeixinMock = mocks.sendMessageWeixin
const sendWeixinMediaFileMock = mocks.sendWeixinMediaFile
const pauseSessionMock = mocks.pauseSession
const assertSessionActiveMock = mocks.assertSessionActive
const sendTypingMock = mocks.sendTyping
const getConfigMock = mocks.getConfig
const getForUserMock = mocks.getForUser
const invalidateUserMock = mocks.invalidateUser

vi.mock('../im/wechat/messaging/send', () => ({
  sendMessageWeixin: mocks.sendMessageWeixin,
  StreamingMarkdownFilter: mocks.StreamingMarkdownFilter,
}))
vi.mock('../im/wechat/messaging/send-media', () => ({
  sendWeixinMediaFile: mocks.sendWeixinMediaFile,
}))
vi.mock('../im/wechat/api/api', () => ({
  apiGetFetch: mocks.apiGetFetch,
  getUpdates: mocks.vendoredGetUpdates,
  sendTyping: mocks.sendTyping,
  getConfig: mocks.getConfig,
  notifyStart: vi.fn().mockResolvedValue({ ret: 0 }),
  notifyStop: vi.fn().mockResolvedValue({ ret: 0 }),
}))
vi.mock('../im/wechat/api/config-cache', () => ({
  WeixinConfigManager: class {
    getForUser = mocks.getForUser
    invalidateUser = mocks.invalidateUser
  },
}))
vi.mock('../im/wechat/api/session-guard', () => ({
  SESSION_EXPIRED_ERRCODE: -14,
  assertSessionActive: mocks.assertSessionActive,
  pauseSession: mocks.pauseSession,
}))
vi.mock('../im/wechat/cdn/pic-decrypt', () => ({
  downloadAndDecryptBuffer: vi.fn(),
  downloadPlainCdnBuffer: vi.fn(),
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { WeChatAdapter } from '../im/wechat-adapter'

describe('WeChatAdapter', () => {
  beforeEach(() => {
    sendMessageWeixinMock.mockReset()
    sendWeixinMediaFileMock.mockReset()
    pauseSessionMock.mockReset()
    assertSessionActiveMock.mockReset()
    sendTypingMock.mockReset()
    getConfigMock.mockReset()
    getForUserMock.mockReset()
    invalidateUserMock.mockReset()
    sendMessageWeixinMock.mockResolvedValue({ messageId: 'cid-1' })
    sendWeixinMediaFileMock.mockResolvedValue({ messageId: 'cid-2' })
    sendTypingMock.mockResolvedValue(undefined)
    getConfigMock.mockResolvedValue({ ret: 0, typing_ticket: 'ticket-1' })
    getForUserMock.mockResolvedValue({ typingTicket: 'ticket-1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sendText forwards to vendored sendMessageWeixin with contextToken', async () => {
    const adapter = new WeChatAdapter({ token: 'tok-12345678' } as any)

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx-abc' }, 'hello')

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
    const arg = sendMessageWeixinMock.mock.calls[0][0]
    expect(arg.to).toBe('u1')
    expect(arg.text).toBe('hello')
    expect(arg.opts.contextToken).toBe('ctx-abc')
    expect(arg.opts.token).toBe('tok-12345678')
  })

  it('sendText truncates messages longer than 4000 chars', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    const longText = 'a'.repeat(5000)

    await adapter.sendText({ userId: 'u1' }, longText)

    const arg = sendMessageWeixinMock.mock.calls[0][0]
    expect(arg.text.length).toBeLessThanOrEqual(4000)
    expect(arg.text.endsWith('(已截断)')).toBe(true)
  })

  it('sendImage forwards to vendored sendWeixinMediaFile', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await adapter.sendImage({ userId: 'u1', contextToken: 'ctx' }, '/tmp/x.jpg')

    expect(sendWeixinMediaFileMock).toHaveBeenCalledTimes(1)
    const arg = sendWeixinMediaFileMock.mock.calls[0][0]
    expect(arg.filePath).toBe('/tmp/x.jpg')
    expect(arg.to).toBe('u1')
    expect(arg.opts.contextToken).toBe('ctx')
    expect(arg.cdnBaseUrl).toContain('weixin.qq.com')
  })

  it('sendText pauses session when vendored throws errcode=-14', async () => {
    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 200: {"ret":-14,"errmsg":"session expired"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok-abc' } as any)

    await expect(
      adapter.sendText({ userId: 'u1' }, 'hi'),
    ).rejects.toThrow(/session expired/)

    expect(pauseSessionMock).toHaveBeenCalledTimes(1)
    expect(pauseSessionMock.mock.calls[0][0]).toContain('sf-wechat-')
  })

  it('sendText does NOT pause session for other errors', async () => {
    sendMessageWeixinMock.mockRejectedValue(
      new Error('sendMessage 500: {"errcode":-99,"errmsg":"unknown"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(
      adapter.sendText({ userId: 'u1' }, 'hi'),
    ).rejects.toThrow()

    expect(pauseSessionMock).not.toHaveBeenCalled()
  })

  it('sendText calls assertSessionActive before vendored call', async () => {
    const calls: string[] = []
    assertSessionActiveMock.mockImplementation(() => calls.push('assert'))
    sendMessageWeixinMock.mockImplementation(async () => {
      calls.push('send')
      return { messageId: 'x' }
    })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await adapter.sendText({ userId: 'u1' }, 'hi')

    expect(calls).toEqual(['assert', 'send'])
  })

  it('sendText surfaces session-paused exception from assert', async () => {
    assertSessionActiveMock.mockImplementation(() => {
      throw new Error('session paused')
    })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(adapter.sendText({ userId: 'u1' }, 'hi')).rejects.toThrow(/session paused/)
    expect(sendMessageWeixinMock).not.toHaveBeenCalled()
  })

  it('start throws when no token is set', async () => {
    const adapter = new WeChatAdapter({} as any)
    await expect(adapter.start()).rejects.toThrow(/login first/)
  })

  it('isConnected reports false initially', () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    expect(adapter.isConnected()).toBe(false)
  })

  it('getCredentials returns current token and baseUrl', () => {
    const adapter = new WeChatAdapter({
      token: 'tok-xyz',
      baseUrl: 'https://example.test',
    } as any)
    expect(adapter.getCredentials()).toEqual({
      token: 'tok-xyz',
      baseUrl: 'https://example.test',
    })
  })

  it('sendText retries once on errcode=-2 after refreshing config', async () => {
    sendMessageWeixinMock
      .mockRejectedValueOnce(
        new Error('sendMessage 200: {"errcode":-2,"errmsg":"unknown"}'),
      )
      .mockResolvedValueOnce({ messageId: 'cid-retry' })
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello')

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(2)
  })

  it('beginOutboundSession and endOutboundSession are exposed on adapter', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    expect(typeof adapter.beginOutboundSession).toBe('function')
    expect(typeof adapter.endOutboundSession).toBe('function')
    await expect(adapter.beginOutboundSession({ userId: 'u1' })).resolves.toBeUndefined()
    adapter.endOutboundSession({ userId: 'u1' })
  })

  it('beginOutboundSession fires sendTyping immediately and endOutboundSession sends CANCEL', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })

    // 等 fire() 的微任务跑完
    await new Promise((r) => setImmediate(r))

    // 至少 fire 一次（status=TYPING=1）
    expect(sendTypingMock).toHaveBeenCalled()
    const typingCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 1)
    expect(typingCalls.length).toBeGreaterThanOrEqual(1)
    expect(typingCalls[0][0].body.typing_ticket).toBe('ticket-1')

    adapter.endOutboundSession({ userId: 'u1' })
    await new Promise((r) => setImmediate(r))

    // CANCEL=2 应被发出
    const cancelCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 2)
    expect(cancelCalls.length).toBe(1)
  })

  it('keepalive auto-restarts after consecutive sendTyping failures', async () => {
    // 让 fire 永远抛错；CANCEL 不算失败
    sendTypingMock.mockImplementation(({ body }: any) => {
      if (body?.status === 2) return Promise.resolve(undefined)
      return Promise.reject(
        new Error('/ilink/bot/sendtyping: errcode=-2 errmsg=invalid context'),
      )
    })
    getForUserMock
      .mockResolvedValueOnce({ typingTicket: 'ticket-old' })
      .mockResolvedValue({ typingTicket: 'ticket-new' })

    vi.useFakeTimers()
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    // 让初始 fire 的 .catch 链跑完
    await Promise.resolve(); await Promise.resolve()

    // 推进 2 次 setInterval（5s/次）使 consecutiveFailures 达到 3 触发 restart
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const typingCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 1)
    expect(typingCalls.length).toBeGreaterThanOrEqual(3)
    expect(invalidateUserMock).toHaveBeenCalled()
    expect(getForUserMock.mock.calls.length).toBeGreaterThanOrEqual(2)

    adapter.endOutboundSession({ userId: 'u1' })
    vi.useRealTimers()
  })

  it('sendText with errcode=-2 refreshes keepalive ticket on retry', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    await Promise.resolve(); await Promise.resolve()

    sendMessageWeixinMock
      .mockRejectedValueOnce(
        new Error('sendMessage 200: {"errcode":-2,"errmsg":"unknown"}'),
      )
      .mockResolvedValueOnce({ messageId: 'cid-retry' })
    invalidateUserMock.mockClear()
    const getForUserCallsBefore = getForUserMock.mock.calls.length

    await adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello')

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(2)
    expect(invalidateUserMock).toHaveBeenCalled()
    // withSendRetry 显式 getForUser + restart keepalive 又一次 getForUser，所以至少 2 次新增
    expect(getForUserMock.mock.calls.length).toBeGreaterThan(getForUserCallsBefore)

    adapter.endOutboundSession({ userId: 'u1' })
  })
})
