import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CrashRecorder } from '../crash-recorder'

/**
 * 崩溃记录内核测试。
 *
 * 核心断言围绕一条不可退让的行为契约：正常退出后下次启动不得报崩溃，
 * 异常终止后下次启动必须报崩溃——这是崩溃后补报提示的唯一依据。
 */
describe('CrashRecorder', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-crash-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const make = (version = '11.6.0') => new CrashRecorder(dir, version, 'win32')

  describe('异常退出判定', () => {
    it('首次启动（无任何记录）→ 不报崩溃', () => {
      const verdict = make().markStartup()
      expect(verdict.lastExitWasCrash).toBe(false)
      expect(verdict.consecutiveCrashCount).toBe(0)
    })

    it('正常退出后再启动 → 不报崩溃', () => {
      const first = make()
      first.markStartup()
      first.markCleanExit()

      const verdict = make().markStartup()
      expect(verdict.lastExitWasCrash).toBe(false)
      expect(verdict.consecutiveCrashCount).toBe(0)
    })

    it('未留下正常退出标记（模拟闪退）→ 下次启动报崩溃', () => {
      make().markStartup()  // 不调 markCleanExit：等价于进程被直接干掉

      const verdict = make().markStartup()
      expect(verdict.lastExitWasCrash).toBe(true)
      expect(verdict.consecutiveCrashCount).toBe(1)
    })

    it('连续闪退 → 连续次数累加', () => {
      make().markStartup()  // 第 1 次运行后闪退
      make().markStartup()  // 第 2 次运行后又闪退（此时报 1 次）
      const verdict = make().markStartup()
      expect(verdict.consecutiveCrashCount).toBe(2)
    })

    it('一次正常退出即视为恢复，连续次数归零', () => {
      make().markStartup()
      make().markStartup()
      expect(make().markStartup().consecutiveCrashCount).toBe(2)

      const recovered = make()
      recovered.markStartup()
      recovered.markCleanExit()

      const verdict = make().markStartup()
      expect(verdict.lastExitWasCrash).toBe(false)
      expect(verdict.consecutiveCrashCount).toBe(0)
    })

    it('崩溃跨版本时，补记的事件与判定都归属上次那个版本', () => {
      make('11.5.0').markStartup()  // 11.5.0 崩了

      const verdict = make('11.6.0').markStartup()
      expect(verdict.previousVersion).toBe('11.5.0')

      const events = make('11.6.0').getRecentEvents()
      const backfilled = events.find(e => e.kind === 'previous-exit')
      expect(backfilled?.appVersion).toBe('11.5.0')
      expect(backfilled?.previousStartedAt).toBeTruthy()
      expect(Date.parse(backfilled!.previousStartedAt!)).not.toBeNaN()
    })

    it('状态文件损坏 → 按首次启动处理，不抛错', () => {
      fs.writeFileSync(path.join(dir, 'runtime-state.json'), '{ 这不是 json', 'utf-8')
      let verdict
      expect(() => { verdict = make().markStartup() }).not.toThrow()
      expect(verdict!.lastExitWasCrash).toBe(false)
      expect(verdict!.consecutiveCrashCount).toBe(0)
    })
  })

  describe('崩溃事件记录', () => {
    it('记录子进程崩溃，保留定位模块所需的身份信息', () => {
      const r = make()
      r.markStartup()
      r.record({
        kind: 'child-gone',
        processType: 'Utility',
        serviceName: 'embedding-worker',
        reason: 'crashed',
        exitCode: -1073741819,
      })

      const [event] = make().getRecentEvents().filter(e => e.kind === 'child-gone')
      expect(event.serviceName).toBe('embedding-worker')
      expect(event.exitCode).toBe(-1073741819)
      expect(event.appVersion).toBe('11.6.0')
      expect(event.platform).toBe('win32')
      expect(Date.parse(event.at)).not.toBeNaN()
    })

    it('本次运行的崩溃计数不含上次崩溃的补记', () => {
      make().markStartup()  // 造一次闪退

      const r = make()
      r.markStartup()       // 补记 previous-exit
      expect(r.getSummary().crashesThisRun).toBe(0)

      r.record({ kind: 'renderer-gone', reason: 'crashed' })
      expect(r.getSummary().crashesThisRun).toBe(1)
    })

    it('损坏的记录行被跳过，不毁掉整份记录', () => {
      const r = make()
      r.markStartup()
      r.record({ kind: 'main-uncaught', message: 'boom' })
      fs.appendFileSync(path.join(dir, 'crash-events.jsonl'), '{ 半行坏数据\n', 'utf-8')
      r.record({ kind: 'renderer-gone', reason: 'oom' })

      const events = make().getRecentEvents()
      expect(events.map(e => e.kind)).toEqual(['main-uncaught', 'renderer-gone'])
    })

    it('崩溃循环也不会把记录写到无限大', () => {
      const r = make()
      r.markStartup()
      // 每条约 1KB，300 条 ≈ 300KB，超过裁剪阈值
      for (let i = 0; i < 300; i++) {
        r.record({ kind: 'child-gone', serviceName: `worker-${i}`, message: 'x'.repeat(1000) })
      }

      const lines = fs.readFileSync(path.join(dir, 'crash-events.jsonl'), 'utf-8').split('\n').filter(Boolean)
      expect(lines.length).toBeLessThanOrEqual(200)
      // 裁剪保留最近的记录
      expect(lines[lines.length - 1]).toContain('worker-299')
    })

    it('目录不存在时按需创建，不因诊断落盘失败影响主流程', () => {
      const nested = path.join(dir, 'a', 'b', 'diagnostics')
      const r = new CrashRecorder(nested, '11.6.0', 'win32')
      expect(() => r.markStartup()).not.toThrow()
      expect(fs.existsSync(path.join(nested, 'runtime-state.json'))).toBe(true)
    })
  })
})
