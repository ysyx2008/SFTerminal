/**
 * 崩溃诊断服务 —— 环境采集、摘要拼装、诊断包打包
 *
 * 一切收集与打包都走异步流式：诊断本身绝不能把界面卡住，否则「崩溃诊断」
 * 会变成新的卡顿来源。日志只读尾部，转储只取最近几个并设总量上限——
 * 一个发不出去的大包等于没有包。
 *
 * 设计目标见 SPEC.md。
 */
import { app } from 'electron'
import { createWriteStream } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ZipArchive } from 'archiver'
import type { CrashSummary, DiagnosticsPackageResult } from '@sailfish/shared-types'
import { createLogger } from '../../utils/logger'
import { getCrashRecorder, getCrashDumpDir } from './collector'
import { buildRedactor, type Redactor } from './redact'
import { buildCrashSummaryText, type DiagnosticsEnv } from './summary'

const log = createLogger('Diagnostics')

/** 摘要里带的崩溃前日志行数：够看出崩在哪一步，又不至于让人粘不出去 */
const SUMMARY_LOG_LINES = 30
/** 单个日志文件只取尾部这么多字节——日志能长到几十 MB，全读会卡 */
const LOG_TAIL_BYTES = 1_500_000
/** 诊断包最多收几个日志文件（按日期倒序） */
const MAX_LOG_FILES = 4
/** 诊断包最多收几个崩溃转储 */
const MAX_DUMPS = 5
/** 转储总量上限 */
const MAX_DUMP_BYTES = 40 * 1024 * 1024

interface DumpFile {
  abs: string
  name: string
  mtimeMs: number
  size: number
}

/** 让出事件循环，避免连续的文本处理把主线程占死 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** 只读文件尾部：日志文件可能极大，且崩溃前的内容才有用 */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    const text = buffer.toString('utf-8')
    // 截断处很可能是半行，丢掉它
    return length < size ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

export class DiagnosticsService {
  private redactor: Redactor | null = null

  private get logDir(): string {
    return path.join(app.getPath('userData'), 'logs')
  }

  private get outputDir(): string {
    return path.join(app.getPath('userData'), 'diagnostics')
  }

  /**
   * 脱敏器基于运行时已知的真实值构造。主机名与登录名取自系统，
   * 家目录用于把所有绝对路径压成 ~。
   */
  private getRedactor(): Redactor {
    if (!this.redactor) {
      this.redactor = buildRedactor({
        homeDir: os.homedir(),
        hostName: os.hostname(),
        userName: os.userInfo().username,
      })
    }
    return this.redactor
  }

  async collectEnv(): Promise<DiagnosticsEnv> {
    // appData 不受数据目录迁移影响，与之对比就知道用户是否搬过数据目录
    const defaultUserData = path.join(app.getPath('appData'), app.getName())
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      gpuStatus: this.describeGpuFeatures(),
      gpuDevice: await this.describeGpuDevice(),
      customDataDir: path.resolve(app.getPath('userData')) !== path.resolve(defaultUserData),
    }
  }

  /** Windows 崩溃十有八九和图形栈有关，硬件加速状态是首要线索 */
  private describeGpuFeatures(): string | undefined {
    try {
      const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
      const keys = ['gpu_compositing', 'webgl', 'video_decode', '2d_canvas']
      return keys
        .filter(key => status[key])
        .map(key => `${key}=${status[key]}`)
        .join(', ')
    } catch {
      return undefined
    }
  }

  /** PCI 厂商号是固定值，翻出来比一串十六进制好读 */
  private static readonly GPU_VENDORS: Record<number, string> = {
    0x10de: 'NVIDIA',
    0x1002: 'AMD',
    0x8086: 'Intel',
    0x106b: 'Apple',
  }

  private async describeGpuDevice(): Promise<string | undefined> {
    try {
      // getGPUInfo 在个别驱动上可能迟迟不返回，超时就放弃这一项，不拖住整份摘要
      const info = await Promise.race([
        app.getGPUInfo('basic') as Promise<{
          gpuDevice?: Array<{ vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }>
        }>,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
      ])
      const devices = info?.gpuDevice ?? []
      if (devices.length === 0) return undefined
      return devices
        .map(d => {
          const vendor = d.vendorId !== undefined
            ? DiagnosticsService.GPU_VENDORS[d.vendorId] ?? `vendor 0x${d.vendorId.toString(16)}`
            : 'vendor 未知'
          const device = d.deviceId !== undefined ? `0x${d.deviceId.toString(16)}` : '未知'
          const driver = d.driverVersion ? ` 驱动 ${d.driverVersion}` : ''
          return `${vendor} ${device}${driver}${d.active ? ' (活动)' : ''}`
        })
        .join('; ')
    } catch {
      return undefined
    }
  }

  /** 崩溃转储按时间倒序：最近的最相关 */
  private async collectDumps(): Promise<DumpFile[]> {
    const root = getCrashDumpDir()
    const found: DumpFile[] = []
    const scan = async (dir: string, depth: number): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        // 平台各自把转储放在 reports / completed / pending 子目录里
        if (entry.isDirectory() && depth > 0) {
          await scan(abs, depth - 1)
        } else if (entry.isFile() && entry.name.endsWith('.dmp')) {
          try {
            const stat = await fs.stat(abs)
            found.push({ abs, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size })
          } catch {
            /* 转储可能正在写入，跳过 */
          }
        }
      }
    }
    await scan(root, 2)
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /**
   * 诊断包只收 logs 目录下的运行日志。AI 对话原文写在另一个目录里，
   * 天然不在收集范围内——这是「对话原文不进诊断包」这条承诺的落点。
   */
  private async collectLogFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.logDir)
      return entries
        .filter(name => name.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, MAX_LOG_FILES)
    } catch {
      return []
    }
  }

  /** 摘要里附的崩溃前日志：取最新一份日志的尾部若干行 */
  private async readRecentLogLines(): Promise<string[]> {
    const [latest] = await this.collectLogFiles()
    if (!latest) return []
    try {
      const tail = await readTail(path.join(this.logDir, latest), 64 * 1024)
      return tail.split('\n').filter(Boolean).slice(-SUMMARY_LOG_LINES)
    } catch {
      return []
    }
  }

  async getCrashSummary(): Promise<CrashSummary> {
    const recorder = getCrashRecorder()
    const base: CrashSummary = recorder?.getSummary() ?? {
      lastExitWasCrash: false,
      consecutiveCrashCount: 0,
      crashesThisRun: 0,
      recentEvents: [],
    }
    const dumps = await this.collectDumps()
    return { ...base, dumpCount: dumps.length }
  }

  /** 可直接粘贴的崩溃摘要 */
  async getCrashSummaryText(): Promise<string> {
    const [env, crash, recentLogLines, dumps] = await Promise.all([
      this.collectEnv(),
      this.getCrashSummary(),
      this.readRecentLogLines(),
      this.collectDumps(),
    ])
    return buildCrashSummaryText(
      { env, crash, recentLogLines, latestDumpName: dumps[0]?.name },
      this.getRedactor()
    )
  }

  /**
   * 生成完整诊断包。日志逐个脱敏后写入，转储原样收录（二进制里没有可读的
   * 用户路径以外的东西，且它就是给我们还原崩溃栈用的）。
   */
  async createPackage(targetPath?: string): Promise<DiagnosticsPackageResult> {
    try {
      const redact = this.getRedactor()
      const [env, crash, dumps, logFiles] = await Promise.all([
        this.collectEnv(),
        this.getCrashSummary(),
        this.collectDumps(),
        this.collectLogFiles(),
      ])

      await fs.mkdir(this.outputDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outPath = targetPath || path.join(this.outputDir, `sailfish-diagnostics-${stamp}.zip`)

      const output = createWriteStream(outPath)
      const archive = new ZipArchive({ zlib: { level: 6 } })
      const closed = new Promise<void>((resolve, reject) => {
        output.on('close', () => resolve())
        output.on('error', reject)
      })
      let failure: Error | null = null
      archive.on('error', (err: Error) => { failure = err })
      archive.on('warning', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') failure = err
      })
      archive.pipe(output)

      const summaryText = buildCrashSummaryText(
        { env, crash, recentLogLines: await this.readRecentLogLines(), latestDumpName: dumps[0]?.name },
        redact
      )
      archive.append(summaryText, { name: 'summary.txt' })
      archive.append(JSON.stringify(env, null, 2), { name: 'env.json' })
      archive.append(redact(JSON.stringify(crash, null, 2)), { name: 'crash-events.json' })

      for (const name of logFiles) {
        try {
          const text = await readTail(path.join(this.logDir, name), LOG_TAIL_BYTES)
          archive.append(redact(text), { name: `logs/${name}` })
        } catch (err) {
          log.warn(`日志 ${name} 收集失败:`, err)
        }
        // 脱敏是同步文本处理，逐个文件让出事件循环，避免累积成一次长卡顿
        await yieldToEventLoop()
      }

      let dumpBytes = 0
      let dumpCount = 0
      for (const dump of dumps) {
        if (dumpCount >= MAX_DUMPS || dumpBytes + dump.size > MAX_DUMP_BYTES) break
        // 转储压缩率很高，压过再发比原样收录更容易发出去
        archive.file(dump.abs, { name: `dumps/${dump.name}` })
        dumpBytes += dump.size
        dumpCount += 1
      }

      await archive.finalize()
      await closed
      if (failure) throw failure

      const { size } = await fs.stat(outPath)
      log.info(`诊断包已生成: ${outPath} (${Math.round(size / 1024)} KB，含 ${dumpCount} 个转储)`)
      return { success: true, filePath: outPath, sizeBytes: size }
    } catch (err) {
      log.error('生成诊断包失败:', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

let instance: DiagnosticsService | null = null

export function getDiagnosticsService(): DiagnosticsService {
  if (!instance) instance = new DiagnosticsService()
  return instance
}
