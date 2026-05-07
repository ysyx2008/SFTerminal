import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 调用会被 hoist 到文件顶部，引用的变量必须用 vi.hoisted。
const mocks = vi.hoisted(() => ({
  sendMessageWeixin: vi.fn(),
  sendWeixinMediaFile: vi.fn(),
  vendoredGetUpdates: vi.fn(),
  apiGetFetch: vi.fn(),
  pauseSession: vi.fn(),
  assertSessionActive: vi.fn(),
}))
const sendMessageWeixinMock = mocks.sendMessageWeixin
const sendWeixinMediaFileMock = mocks.sendWeixinMediaFile
const pauseSessionMock = mocks.pauseSession
const assertSessionActiveMock = mocks.assertSessionActive

vi.mock('../im/wechat/messaging/send', () => ({
  sendMessageWeixin: mocks.sendMessageWeixin,
}))
vi.mock('../im/wechat/messaging/send-media', () => ({
  sendWeixinMediaFile: mocks.sendWeixinMediaFile,
}))
vi.mock('../im/wechat/api/api', () => ({
  apiGetFetch: mocks.apiGetFetch,
  getUpdates: mocks.vendoredGetUpdates,
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
    sendMessageWeixinMock.mockResolvedValue({ messageId: 'cid-1' })
    sendWeixinMediaFileMock.mockResolvedValue({ messageId: 'cid-2' })
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
    sendMessageWeixinMock.mockRejectedValueOnce(
      new Error('sendMessage 500: {"errcode":-2,"errmsg":"unknown"}'),
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
})
