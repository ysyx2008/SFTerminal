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

  it('sendText surfaces send failure without pausing on errcode=-14 (pause handled in pollLoop)', async () => {
    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 200: {"ret":-14,"errmsg":"session expired"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok-abc' } as any)

    await expect(
      adapter.sendText({ userId: 'u1' }, 'hi'),
    ).rejects.toThrow(/session expired/)

    // 对齐官方 SDK：发送路径不再解析 body errcode，-14（会话过期）只由 pollLoop
    // 通过 resp.ret 统一处理，sendText 仅原样透传异常、不暂停会话。
    expect(pauseSessionMock).not.toHaveBeenCalled()
    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
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

  it('sendText does NOT retry on errcode=-2 (aligned with official SDK)', async () => {
    // 官方 SDK 在 api 层静默吞掉 errcode=-2；适配器不再做"刷新 config 后重试一次"，
    // 失败直接透传，sendmessage 只调用一次。
    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 200: {"errcode":-2,"errmsg":"unknown"}'),
    )
    const adapter = new WeChatAdapter({ token: 'tok' } as any)

    await expect(
      adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello'),
    ).rejects.toThrow()

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
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

  it('keepalive keeps firing on sendTyping failures without self-heal (aligned with official SDK)', async () => {
    // 让 fire 永远抛错；CANCEL 不算失败
    sendTypingMock.mockImplementation(({ body }: any) => {
      if (body?.status === 2) return Promise.resolve(undefined)
      return Promise.reject(
        new Error('/ilink/bot/sendtyping: errcode=-2 errmsg=invalid context'),
      )
    })

    vi.useFakeTimers()
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    // 让初始 fire 的 .catch 链跑完
    await Promise.resolve(); await Promise.resolve()

    // begin 阶段会调用 getForUser（出站会话 + keepalive 各一次），之后失败不应再触发刷新
    const getForUserCallsAfterBegin = getForUserMock.mock.calls.length

    // 推进多次 5s interval：每次都按固定 ticket 重发，下次 interval 自然重试即可
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    const typingCalls = sendTypingMock.mock.calls.filter((c) => c[0]?.body?.status === 1)
    // 初始 fire + 2 次 interval = 至少 3 次
    expect(typingCalls.length).toBeGreaterThanOrEqual(3)
    // 失败只 log，不再 invalidateUser / 重新 getForUser 自愈重启
    expect(invalidateUserMock).not.toHaveBeenCalled()
    expect(getForUserMock.mock.calls.length).toBe(getForUserCallsAfterBegin)

    adapter.endOutboundSession({ userId: 'u1' })
    vi.useRealTimers()
  })

  it('sendText with active session does NOT retry or refresh ticket on errcode=-2', async () => {
    const adapter = new WeChatAdapter({ token: 'tok' } as any)
    await adapter.beginOutboundSession({ userId: 'u1', contextToken: 'ctx-1' })
    await Promise.resolve(); await Promise.resolve()

    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 200: {"errcode":-2,"errmsg":"unknown"}'),
    )
    invalidateUserMock.mockClear()
    const getForUserCallsBefore = getForUserMock.mock.calls.length

    // 对齐官方 SDK：失败不再重试，也不刷新 keepalive ticket，异常原样透传
    await expect(
      adapter.sendText({ userId: 'u1', contextToken: 'ctx-1' }, 'hello'),
    ).rejects.toThrow()

    expect(sendMessageWeixinMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserMock).not.toHaveBeenCalled()
    expect(getForUserMock.mock.calls.length).toBe(getForUserCallsBefore)

    adapter.endOutboundSession({ userId: 'u1' })
  })
})
