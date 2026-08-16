import { describe, it, expect } from 'vitest'
import type { CrashSummary } from '@sailfish/shared-types'
import { buildCrashSummaryText, describeExitCode, type DiagnosticsEnv } from '../summary'
import { buildRedactor } from '../redact'

const env: DiagnosticsEnv = {
  appVersion: '11.6.0',
  platform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
  totalMemoryMb: 16384,
  gpuDevice: 'NVIDIA GeForce RTX 3060 (驱动 31.0.15.3623)',
  gpuStatus: 'gpu_compositing: enabled_on',
  customDataDir: false,
}

const crash: CrashSummary = {
  lastExitWasCrash: true,
  consecutiveCrashCount: 3,
  previousVersion: '11.6.0',
  crashesThisRun: 1,
  dumpCount: 2,
  recentEvents: [
    { at: '2026-08-15T02:00:00.000Z', appVersion: '11.6.0', platform: 'win32', kind: 'child-gone', processType: 'GPU', serviceName: 'GPU', reason: 'crashed', exitCode: 1 },
    { at: '2026-08-16T03:00:00.000Z', appVersion: '11.6.0', platform: 'win32', kind: 'renderer-gone', processType: 'renderer', reason: 'crashed', exitCode: -1073741819 },
  ],
}

describe('退出码翻译', () => {
  it('把 Windows 异常码翻成崩溃性质——这是判断原生崩溃还是逻辑异常的关键', () => {
    expect(describeExitCode(-1073741819)).toContain('0xc0000005')
    expect(describeExitCode(-1073741819)).toContain('原生内存错误')
  })

  it('未收录的异常码至少给出十六进制，便于自行查', () => {
    expect(describeExitCode(-1073741510)).toBe('-1073741510 (0xc000013a)')
  })

  it('正常退出码原样呈现，缺失时不编造', () => {
    expect(describeExitCode(0)).toBe('0')
    expect(describeExitCode(undefined)).toBe('-')
  })
})

describe('崩溃摘要文本', () => {
  const redact = buildRedactor({ homeDir: 'C:\\Users\\Alice', userName: 'Alice' })

  it('包含归类崩溃所需的全部关键信息', () => {
    const text = buildCrashSummaryText({ env, crash }, redact)
    expect(text).toContain('11.6.0')
    expect(text).toContain('win32 10.0.22631')
    expect(text).toContain('界面进程崩溃')
    expect(text).toContain('0xc0000005')
    expect(text).toContain('连续异常退出: 3 次')
    expect(text).toContain('RTX 3060')
    expect(text).toContain('崩溃转储: 2 个')
  })

  it('列出此前的崩溃事件——同类反复出现才看得出是不是普遍问题', () => {
    const text = buildCrashSummaryText({ env, crash }, redact)
    expect(text).toContain('此前的崩溃事件')
    expect(text).toContain('子进程崩溃 (GPU)')
  })

  it('崩溃前日志与事件补充都经过脱敏', () => {
    const text = buildCrashSummaryText({
      env,
      crash: {
        ...crash,
        recentEvents: [{
          at: '2026-08-16T03:00:00.000Z', appVersion: '11.6.0', platform: 'win32',
          kind: 'main-uncaught', message: 'ENOENT C:\\Users\\Alice\\AppData\\x.json',
        }],
      },
      recentLogLines: ['[error] 写入 C:\\Users\\Alice\\logs 失败'],
    }, redact)
    expect(text).not.toContain('Alice')
    expect(text).toContain('~\\AppData\\x.json')
    expect(text).toContain('~\\logs')
  })

  it('补报上次退出时，日志标题标明来自上次运行', () => {
    const text = buildCrashSummaryText({
      env,
      crash: {
        lastExitWasCrash: true,
        consecutiveCrashCount: 1,
        crashesThisRun: 0,
        recentEvents: [{
          at: '2026-08-16T08:13:06.916Z', appVersion: '11.6.0', platform: 'darwin',
          kind: 'previous-exit', previousStartedAt: '2026-08-16T08:11:48.000Z',
          message: '上次运行（启动于 2026-08-16T08:11:48.000Z）未正常退出',
        }],
      },
      recentLogLines: ['[16:12:58.135] [info]  (Agent) search_history'],
      dumpHints: 'V8 堆内存耗尽（CALL_AND_RETRY_LAST）；EXC_BREAKPOINT（断点/主动中止，常见于内存耗尽） (0x6)',
    }, redact)
    expect(text).toContain('崩溃前日志（上次运行）')
    expect(text).not.toContain('最近日志:')
    expect(text).toContain('转储标注: V8 堆内存耗尽')
    expect(text).toContain('search_history')
  })

  it('没有崩溃事件时如实说明，不伪造一条', () => {
    const text = buildCrashSummaryText({
      env,
      crash: { lastExitWasCrash: false, consecutiveCrashCount: 0, crashesThisRun: 0, recentEvents: [] },
    }, redact)
    expect(text).toContain('未记录到崩溃事件')
  })
})
