import { describe, it, expect, vi } from 'vitest'
import { forceCloseClient, SshConnectAttempt } from '../ssh-connect-attempt'
import type { Client } from 'ssh2'

function fakeClient(overrides: Partial<Client> = {}): Client {
  return {
    end: vi.fn(),
    destroy: vi.fn(),
    ...overrides
  } as unknown as Client
}

describe('forceCloseClient', () => {
  it('强拆，不走会堵住主进程的优雅断开', () => {
    const client = fakeClient()
    forceCloseClient(client)
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.end).not.toHaveBeenCalled()
  })

  it('已经拆过也不抛', () => {
    const client = fakeClient({
      destroy: vi.fn(() => { throw new Error('already destroyed') })
    })
    expect(() => forceCloseClient(client)).not.toThrow()
  })
})

describe('SshConnectAttempt', () => {
  it('取消时强拆已登记的客户端', () => {
    const client = fakeClient()
    const attempt = new SshConnectAttempt()
    attempt.trackClient(client)
    attempt.cancel()
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.end).not.toHaveBeenCalled()
  })
})
