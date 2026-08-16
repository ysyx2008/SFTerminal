import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UtilityWorkerSession, type WorkerProcessLike } from '../worker-session'

/**
 * 假 worker 进程：可手动触发 message / exit，用来复现「旧进程的死讯在新进程
 * 建立之后才到达」这类时序——真 utilityProcess 的 kill 正是异步生效的。
 */
class FakeProc implements WorkerProcessLike {
  killed = false
  sent: any[] = []
  private messageListeners: Array<(m: any) => void> = []
  private exitListeners: Array<(code: number | null) => void> = []

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  kill(): void {
    this.killed = true
  }

  on(event: 'message' | 'exit', listener: any): void {
    if (event === 'message') this.messageListeners.push(listener)
    else this.exitListeners.push(listener)
  }

  emitMessage(message: any): void {
    for (const l of this.messageListeners) l(message)
  }

  /** 模拟进程退出（kill 生效或自然结束） */
  emitExit(code: number | null): void {
    for (const l of this.exitListeners) l(code)
  }

  /** 回应最近一条请求，便于驱动 call() */
  replyTo(index: number, payload: Record<string, unknown>): void {
    const req = this.sent[index]
    this.emitMessage({ id: req.id, ...payload })
  }
}

const log = { info: vi.fn(), warn: vi.fn() }

function spawnWith(proc: FakeProc, label = 'Embedding') {
  return UtilityWorkerSession.spawn({
    // 用一个必定存在的路径绕过脚本存在性检查
    scriptPath: process.cwd(),
    env: {},
    label,
    defaultTimeoutMs: 1000,
    log,
    fork: () => proc
  })
}

describe('UtilityWorkerSession', () => {
  beforeEach(() => {
    log.info.mockClear()
    log.warn.mockClear()
  })

  it('请求按 id 路由回对应调用方', async () => {
    const proc = new FakeProc()
    const session = spawnWith(proc)

    const call = session.call<{ ok: boolean }>('embed', { texts: ['a'] })
    expect(proc.sent).toHaveLength(1)
    proc.replyTo(0, { success: true, result: { ok: true } })

    await expect(call).resolves.toEqual({ ok: true })
  })

  it('worker 报错时把错误与 worker 栈交给调用方', async () => {
    const proc = new FakeProc()
    const session = spawnWith(proc)

    const call = session.call('embed')
    proc.replyTo(0, { success: false, error: '模型未加载', stack: 'at worker' })

    await expect(call).rejects.toThrow('模型未加载')
  })

  it('kill 只杀自己的进程并让自己的请求失败', async () => {
    const procA = new FakeProc()
    const procB = new FakeProc()
    const sessionA = spawnWith(procA)
    const sessionB = spawnWith(procB)

    const callA = sessionA.call('embed')
    const callB = sessionB.call('embed')

    sessionA.kill()

    await expect(callA).rejects.toThrow('Embedding worker terminated')
    expect(procA.killed).toBe(true)
    expect(sessionA.isAlive).toBe(false)

    // 另一代不受牵连：进程没被杀，请求还在等回应
    expect(procB.killed).toBe(false)
    expect(sessionB.isAlive).toBe(true)
    procB.replyTo(0, { success: true, result: 'ok' })
    await expect(callB).resolves.toBe('ok')
  })

  it('上一代退出不影响新一代的进行中请求', async () => {
    const oldProc = new FakeProc()
    const newProc = new FakeProc()
    const oldSession = spawnWith(oldProc)
    const newSession = spawnWith(newProc)

    const oldCall = oldSession.call('initialize')
    const newCall = newSession.call('initialize')

    // 旧进程的 exit 迟到：它只能清算自己的账
    oldSession.kill()
    oldProc.emitExit(0)

    await expect(oldCall).rejects.toThrow(/terminated|exited with code/)
    expect(newSession.isAlive).toBe(true)

    newProc.replyTo(0, { success: true, result: { device: 'cpu' } })
    await expect(newCall).resolves.toEqual({ device: 'cpu' })
  })

  it('退出通知带上退出码，供调用方判断是否为当前会话', () => {
    const proc = new FakeProc()
    const session = spawnWith(proc)

    const seen: Array<number | null> = []
    session.onExit(code => seen.push(code))

    proc.emitExit(3)

    expect(seen).toEqual([3])
    expect(session.isAlive).toBe(false)
  })

  it('进程已退出后新请求直接失败，不会悬挂', async () => {
    const proc = new FakeProc()
    const session = spawnWith(proc)

    proc.emitExit(0)

    await expect(session.call('embed')).rejects.toThrow('Embedding worker 未启动')
  })

  it('label 区分不同 worker 的错误信息', async () => {
    const proc = new FakeProc()
    const session = spawnWith(proc, 'LanceDB')

    const call = session.call('search')
    session.kill()

    await expect(call).rejects.toThrow('LanceDB worker terminated')
  })

  it('fork 返回 null（CLI / 测试环境）时抛错，由调用方决定降级', () => {
    expect(() =>
      UtilityWorkerSession.spawn({
        scriptPath: process.cwd(),
        env: {},
        label: 'Embedding',
        defaultTimeoutMs: 1000,
        log,
        fork: () => null
      })
    ).toThrow(/fork 返回 null/)
  })

  it('worker 脚本不存在时抛错并指出路径', () => {
    expect(() =>
      UtilityWorkerSession.spawn({
        scriptPath: '/definitely/not/here/worker.js',
        env: {},
        label: 'Embedding',
        defaultTimeoutMs: 1000,
        log,
        fork: () => new FakeProc()
      })
    ).toThrow(/worker 脚本不存在/)
  })

  describe('超时', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('超时后请求失败且不再占用队列', async () => {
      const proc = new FakeProc()
      const session = spawnWith(proc)

      const call = session.call('embed', undefined, 500)
      const assertion = expect(call).rejects.toThrow('Embedding worker 调用超时（type=embed）')
      await vi.advanceTimersByTimeAsync(500)
      await assertion

      // 迟到的回应不应触发任何 resolve（队列里已无此请求）
      expect(() => proc.replyTo(0, { success: true, result: 1 })).not.toThrow()
    })
  })
})
