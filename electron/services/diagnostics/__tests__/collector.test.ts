import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-collector-'))
/** 采集器注册的 app 事件处理器，测试里手动触发以模拟平台崩溃信号 */
const appHandlers = new Map<string, (...args: unknown[]) => void>()

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'crashDumps' ? path.join(tmpDir, 'dumps') : tmpDir),
    getVersion: () => '11.6.0',
    getName: () => 'SailFish',
    on: (event: string, cb: (...args: unknown[]) => void) => { appHandlers.set(event, cb) },
  },
  crashReporter: { start: vi.fn() },
}))

import { initCrashDiagnostics, isCrashReason, describeChildProcess } from '../collector'
import type { CrashEvent } from '../crash-recorder'

function readEvents(): CrashEvent[] {
  const file = path.join(tmpDir, 'diagnostics', 'crash-events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CrashEvent)
}

function fire(event: string, ...args: unknown[]): void {
  const handler = appHandlers.get(event)
  if (!handler) throw new Error(`未注册 ${event} 处理器`)
  handler(...args)
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('崩溃原因判定', () => {
  it('正常收摊不算崩溃', () => {
    expect(isCrashReason('clean-exit')).toBe(false)
  })

  it('被杀不算崩溃——我们自己就会主动杀工具进程，算进去会让统计失真', () => {
    expect(isCrashReason('killed')).toBe(false)
  })

  it.each(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure'])(
    '%s 算崩溃',
    (reason) => {
      expect(isCrashReason(reason)).toBe(true)
    }
  )
})

describe('子进程身份描述', () => {
  it('优先用可读的进程名', () => {
    expect(describeChildProcess({
      type: 'Utility',
      name: 'Embedding Worker',
      serviceName: 'node.mojom.NodeService',
    })).toBe('Embedding Worker')
  })

  it('没有进程名时退到服务名', () => {
    expect(describeChildProcess({ type: 'Utility', serviceName: 'node.mojom.NodeService' }))
      .toBe('node.mojom.NodeService')
  })

  it('两者都缺时退到进程类型', () => {
    expect(describeChildProcess({ type: 'GPU' })).toBe('GPU')
  })
})

describe('平台崩溃信号接入', () => {
  beforeAll(() => {
    initCrashDiagnostics()
  })

  it('界面进程正常收摊不产生崩溃记录', () => {
    const before = readEvents().length
    fire('render-process-gone', {}, {}, { reason: 'clean-exit', exitCode: 0 })
    expect(readEvents().length).toBe(before)
  })

  it('界面进程崩溃被记下，含退出码', () => {
    fire('render-process-gone', {}, {}, { reason: 'crashed', exitCode: -1073741819 })
    const last = readEvents().at(-1)!
    expect(last.kind).toBe('renderer-gone')
    expect(last.reason).toBe('crashed')
    expect(last.exitCode).toBe(-1073741819)
    expect(last.appVersion).toBe('11.6.0')
  })

  it('子进程崩溃保留完整身份三元组，事后还能区分具体进程', () => {
    fire('child-process-gone', {}, {
      type: 'Utility',
      name: 'Speech Worker',
      serviceName: 'node.mojom.NodeService',
      reason: 'crashed',
      exitCode: 3,
    })
    const last = readEvents().at(-1)!
    expect(last.kind).toBe('child-gone')
    expect(last.serviceName).toBe('Speech Worker')
    expect(last.message).toContain('serviceName=node.mojom.NodeService')
  })

  it('GPU 进程崩溃同样记录', () => {
    fire('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
    const last = readEvents().at(-1)!
    expect(last.processType).toBe('GPU')
  })

  it('正常退出留下标记，下次启动才不会误报崩溃', () => {
    fire('quit')
    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'diagnostics', 'runtime-state.json'), 'utf-8'))
    expect(state.cleanExit).toBe(true)
    expect(state.consecutiveCrashes).toBe(0)
  })
})
