import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import AdmZip from 'adm-zip'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-diag-svc-'))
const userData = path.join(tmpDir, 'userData')
const dumpDir = path.join(tmpDir, 'crashDumps')

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      if (name === 'appData') return path.join(tmpDir, 'appData')
      if (name === 'crashDumps') return dumpDir
      throw new Error(`unexpected getPath: ${name}`)
    },
    getName: () => 'SailFish',
    getVersion: () => '11.6.0',
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled_on', webgl: 'enabled_on' }),
    getGPUInfo: () => Promise.resolve({
      gpuDevice: [{ vendorId: 0x10de, deviceId: 0x2504, driverVersion: '31.0.15.3623', active: true }],
    }),
    on: vi.fn(),
  },
  crashReporter: { start: vi.fn() },
}))

import { CrashRecorder } from '../crash-recorder'

const recorder = new CrashRecorder(path.join(userData, 'diagnostics'), '11.6.0', 'win32')

vi.mock('../collector', () => ({
  getCrashRecorder: () => recorder,
  getCrashDumpDir: () => dumpDir,
}))

import { DiagnosticsService } from '../diagnostics.service'

const service = new DiagnosticsService()

beforeAll(() => {
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(userData, 'ai-debug-logs'), { recursive: true })
  fs.mkdirSync(path.join(dumpDir, 'reports'), { recursive: true })

  // 日志里塞进真实家目录，用来验证脱敏确实生效
  fs.writeFileSync(
    path.join(userData, 'logs', '2026-08-16.log'),
    [
      '[info] 启动完成',
      `[error] 写入 ${os.homedir()}/Library/x.json 失败`,
      '[error] 界面进程消失 reason=crashed',
    ].join('\n'),
    'utf-8'
  )
  fs.writeFileSync(path.join(userData, 'logs', '2026-08-15.log'), '[info] 前一天\n', 'utf-8')
  // 对话原文所在目录：不该出现在诊断包里
  fs.writeFileSync(path.join(userData, 'ai-debug-logs', 'chat.log'), '用户说了什么', 'utf-8')

  // 6 个转储，超出单包收录上限
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dumpDir, 'reports', `dump-${i}.dmp`), Buffer.alloc(1024, i))
  }

  recorder.markStartup()
  recorder.record({ kind: 'renderer-gone', processType: 'renderer', reason: 'crashed', exitCode: -1073741819 })
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('崩溃摘要', () => {
  it('带上归类崩溃所需的环境与显卡信息', async () => {
    const text = await service.getCrashSummaryText()
    expect(text).toContain('11.6.0')
    expect(text).toContain('界面进程崩溃')
    expect(text).toContain('0xc0000005')
    expect(text).toContain('NVIDIA')
    expect(text).toContain('gpu_compositing=enabled_on')
    expect(text).toContain('崩溃转储: 6 个')
  })

  it('摘要里的绝对路径已脱敏', async () => {
    const text = await service.getCrashSummaryText()
    expect(text).not.toContain(os.homedir())
    expect(text).toContain('~/Library/x.json')
  })

  it('数据目录未迁移时如实标注', async () => {
    const env = await service.collectEnv()
    expect(env.customDataDir).toBe(true)  // 测试里 userData 就不在默认位置
    expect(env.platform).toBe(process.platform)
  })
})

describe('诊断包', () => {
  let entries: string[] = []
  let zip: AdmZip

  beforeAll(async () => {
    const result = await service.createPackage()
    expect(result.success).toBe(true)
    expect(result.sizeBytes).toBeGreaterThan(0)
    zip = new AdmZip(result.filePath!)
    entries = zip.getEntries().map(e => e.entryName)
  })

  it('包含摘要、环境、崩溃事件与运行日志', () => {
    expect(entries).toContain('summary.txt')
    expect(entries).toContain('env.json')
    expect(entries).toContain('crash-events.json')
    expect(entries).toContain('logs/2026-08-16.log')
  })

  it('不收录 AI 对话原文', () => {
    expect(entries.some(name => name.includes('ai-debug'))).toBe(false)
    const all = zip.getEntries().map(e => e.getData().toString('utf-8')).join('\n')
    expect(all).not.toContain('用户说了什么')
  })

  it('包内日志同样脱敏', () => {
    const logText = zip.getEntry('logs/2026-08-16.log')!.getData().toString('utf-8')
    expect(logText).not.toContain(os.homedir())
    expect(logText).toContain('~/Library/x.json')
  })

  it('崩溃转储收录但有数量上限，不至于大到发不出去', () => {
    const dumps = entries.filter(name => name.startsWith('dumps/'))
    expect(dumps.length).toBe(5)
  })
})
