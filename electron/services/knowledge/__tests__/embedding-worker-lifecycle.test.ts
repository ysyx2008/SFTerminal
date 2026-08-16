import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { WorkerProcessLike, WorkerSessionOptions } from '../worker-session'
import { UtilityWorkerSession } from '../worker-session'

/**
 * 覆盖「worker 换代」的时序要求：孤儿进程曾让线上用户的进程组内存涨到 16GB。
 * 这里不需要真 utilityProcess——要验的是谁杀谁、谁的引用被清、fork 了几次。
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/sailfish-test' },
  utilityProcess: { fork: () => null }
}))

vi.mock('../model-manager', () => ({
  getModelManager: () => ({
    getBestAvailableModel: () => ({ id: 'lite', name: 'lite' }),
    getModel: () => ({ id: 'lite', name: 'lite' }),
    getModelPath: () => '/tmp/models/lite',
    isModelAvailable: () => true
  }),
  ModelManager: class {}
}))

const { EmbeddingService } = await import('../embedding')

/** 应答式假 worker：initialize / embed 都立刻成功，除非被要求失败 */
class FakeWorker implements WorkerProcessLike {
  killed = false
  exited = false
  failInitialize = false
  /** 让本代 worker 的推理请求一律失败，用来逼调用方要求重启 */
  failEmbed = false

  /** 进程是否还在（被杀或自然退出都算没了） */
  get alive(): boolean {
    return !this.killed && !this.exited
  }
  private messageListeners: Array<(m: any) => void> = []
  private exitListeners: Array<(code: number | null) => void> = []

  postMessage(message: any): void {
    queueMicrotask(() => {
      if (this.killed) return
      if (message.type === 'initialize') {
        this.reply(message.id, this.failInitialize
          ? { success: false, error: '模型加载失败' }
          : { success: true, result: { device: 'cpu' } })
      } else if (message.type === 'embed') {
        if (this.failEmbed) {
          this.reply(message.id, { success: false, error: '推理失败' })
          return
        }
        const count = message.data?.texts?.length ?? 1
        this.reply(message.id, {
          success: true,
          result: { flat: new Float32Array(count * 4), dim: 4 }
        })
      } else {
        this.reply(message.id, { success: true, result: {} })
      }
    })
  }

  kill(): void {
    this.killed = true
    // 真 utilityProcess 的 exit 是异步到达的，这正是孤儿问题的温床
    setTimeout(() => this.emitExit(0), 0)
  }

  on(event: 'message' | 'exit', listener: any): void {
    if (event === 'message') this.messageListeners.push(listener)
    else this.exitListeners.push(listener)
  }

  emitExit(code: number | null): void {
    this.exited = true
    for (const l of this.exitListeners) l(code)
  }

  private reply(id: number, payload: Record<string, unknown>): void {
    for (const l of this.messageListeners) l({ id, ...payload })
  }
}

/** 把 fork 换成假进程，并记录每一代，便于断言「谁还活着」 */
class TestEmbeddingService extends EmbeddingService {
  readonly spawned: FakeWorker[] = []
  /** 下一代 worker 是否让 initialize 失败 */
  nextInitializeFails = false

  protected isWorkerModeAvailable(): boolean {
    return true
  }

  protected spawnSession(options: WorkerSessionOptions): UtilityWorkerSession {
    const proc = new FakeWorker()
    proc.failInitialize = this.nextInitializeFails
    this.spawned.push(proc)
    return UtilityWorkerSession.spawn({
      ...options,
      scriptPath: process.cwd(),
      fork: () => proc
    })
  }

  get liveWorkers(): FakeWorker[] {
    return this.spawned.filter(p => p.alive)
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5))

describe('EmbeddingService worker 换代', () => {
  let originalProcessType: unknown

  beforeAll(() => {
    // 让服务认为自己在主进程里，从而走 worker 模式而不是进程内推理
    originalProcessType = (process as any).type
    ;(process as any).type = 'browser'
  })

  afterAll(() => {
    ;(process as any).type = originalProcessType
  })

  let svc: TestEmbeddingService

  beforeEach(() => {
    svc = new TestEmbeddingService()
  })

  it('初始化后只有一个 worker 在跑', async () => {
    await svc.initialize()

    expect(svc.spawned).toHaveLength(1)
    expect(svc.liveWorkers).toHaveLength(1)
    expect(svc.isReady()).toBe(true)
  })

  it('worker 意外退出后重启，全过程只留一个活进程', async () => {
    await svc.initialize()

    svc.spawned[0].emitExit(1) // 进程自己崩了
    await flush()

    const vectors = await svc.embed(['你好'])

    expect(vectors).toHaveLength(1)
    expect(svc.spawned).toHaveLength(2)
    expect(svc.liveWorkers).toHaveLength(1)
  })

  it('worker 已死时多路并发召回只重建一个', async () => {
    await svc.initialize()

    svc.spawned[0].emitExit(1)
    await flush()

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(t => svc.embed([t]))
    )

    expect(results.every(r => r.length === 1)).toBe(true)
    // 死掉的第一代 + 重建的第二代，不该有第三代
    expect(svc.spawned).toHaveLength(2)
    expect(svc.liveWorkers).toHaveLength(1)
  })

  it('多路推理同时失败时共享一次重启，不互相杀掉刚建好的 worker', async () => {
    await svc.initialize()

    // 现场里的形态：worker 还活着，但推理失败，于是每一路都要求重启
    svc.spawned[0].failEmbed = true

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(t => svc.embed([t]))
    )

    expect(results.every(r => r.length === 1)).toBe(true)
    // 各自重启会互相残杀并一路 fork 下去；共享重启则只多出一代
    expect(svc.spawned).toHaveLength(2)
    expect(svc.liveWorkers).toHaveLength(1)
  })

  it('上一代的退出通知迟到时，不会把新一代的引用抹掉', async () => {
    await svc.initialize()
    const firstGen = svc.spawned[0]

    firstGen.emitExit(1)
    await flush()
    await svc.embed(['触发重启'])

    const secondGen = svc.spawned[1]
    expect(secondGen).toBeDefined()

    // 迟到的旧死讯：它已经死了，但不能牵连当前这一代
    firstGen.emitExit(1)
    await flush()

    expect(secondGen.alive).toBe(true)
    expect(svc.isReady()).toBe(true)
    // 新一代仍可用，说明服务没有把它的引用丢掉
    await expect(svc.embed(['仍然可用'])).resolves.toHaveLength(1)
    expect(svc.spawned).toHaveLength(2)
  })

  it('重启握手失败时不留下半成品进程', async () => {
    await svc.initialize()

    svc.spawned[0].emitExit(1)
    await flush()

    svc.nextInitializeFails = true
    await expect(svc.embed(['会失败'])).rejects.toThrow()

    // 握手失败的那些 worker 必须都被回收，不许活着占内存
    expect(svc.liveWorkers).toHaveLength(0)
  })

  it('dispose 后不再持有任何 worker', async () => {
    await svc.initialize()

    await svc.disposeAsync(10)
    await flush()

    expect(svc.liveWorkers).toHaveLength(0)
    expect(svc.isReady()).toBe(false)
  })
})
