/**
 * 崩溃记录 —— 崩溃事件落盘 + 异常退出判定
 *
 * 两条硬约束决定了这个类的写法：
 * 1. 必须能在 app ready 之前工作（早期崩溃也要记得住），所以只依赖 fs 与构造时
 *    注入的目录，不碰 electron 的服务实例，也不引入任何重依赖。
 * 2. 写入发生在崩溃现场，必须极轻：单行追加，同步落盘。不能因为记录本身
 *    再拖垮一次退出。
 *
 * 设计目标见 SPEC.md。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { CrashEvent, CrashKind, CrashStartupVerdict, CrashSummary } from '@sailfish/shared-types'

export type { CrashEvent, CrashKind, CrashStartupVerdict, CrashSummary }

interface RuntimeState {
  /** 上次是否走到了正常退出。启动时置 false，退出时置 true */
  cleanExit: boolean
  startedAt: string
  version: string
  consecutiveCrashes: number
}

export const PACKAGED_STATE_FILE = 'runtime-state.json'
export const DEV_STATE_FILE = 'runtime-state.dev.json'
const EVENTS_FILE = 'crash-events.jsonl'

/** 超过此体积就裁剪到 MAX_EVENT_LINES 行——正常不会触发，崩溃循环时兜住无限增长 */
const MAX_EVENT_BYTES = 128 * 1024
const MAX_EVENT_LINES = 200

export class CrashRecorder {
  private crashesThisRun = 0
  private verdict: CrashStartupVerdict = { lastExitWasCrash: false, consecutiveCrashCount: 0 }

  /**
   * @param dir 诊断数据目录（崩溃状态与事件都落在这里）
   * @param appVersion 当前应用版本
   * @param platform 运行平台
   * @param stateFile 退出标记文件名。未打包与正式版必须分开，否则一边还在跑会被另一边读成崩溃
   */
  constructor(
    private readonly dir: string,
    private readonly appVersion: string,
    private readonly platform: string = process.platform,
    private readonly stateFile: string = PACKAGED_STATE_FILE,
  ) {}

  private get statePath(): string {
    return path.join(this.dir, this.stateFile)
  }

  private get eventsPath(): string {
    return path.join(this.dir, EVENTS_FILE)
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true })
    }
  }

  /** 状态文件损坏/缺失一律按「首次启动、无崩溃」处理，绝不让诊断本身挡住启动 */
  private readState(): RuntimeState | null {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<RuntimeState>
      if (typeof parsed?.cleanExit !== 'boolean') return null
      return {
        cleanExit: parsed.cleanExit,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        version: typeof parsed.version === 'string' ? parsed.version : '',
        consecutiveCrashes: typeof parsed.consecutiveCrashes === 'number' ? parsed.consecutiveCrashes : 0,
      }
    } catch {
      return null
    }
  }

  private writeState(state: RuntimeState): void {
    try {
      this.ensureDir()
      fs.writeFileSync(this.statePath, JSON.stringify(state), 'utf-8')
    } catch {
      /* 诊断落盘失败不影响主流程 */
    }
  }

  /**
   * 启动时调用：判定上次是否异常退出，并把本次运行标记为「进行中」。
   *
   * 判定依据是上次退出有没有留下正常退出标记——主进程崩溃时没有任何 JS 能跑，
   * 这是唯一能事后知道「上次是崩的」的办法，也是崩溃后补报提示的前提。
   */
  markStartup(): CrashStartupVerdict {
    const prev = this.readState()
    const lastExitWasCrash = prev !== null && !prev.cleanExit
    const consecutiveCrashCount = lastExitWasCrash ? prev.consecutiveCrashes + 1 : 0

    this.verdict = {
      lastExitWasCrash,
      consecutiveCrashCount,
      previousVersion: lastExitWasCrash ? (prev.version || undefined) : undefined,
    }

    if (lastExitWasCrash) {
      // 补记的事件归属上次那次运行，所以版本用上次的
      this.appendEvent({
        at: new Date().toISOString(),
        appVersion: prev.version || this.appVersion,
        platform: this.platform,
        kind: 'previous-exit',
        previousStartedAt: prev.startedAt || undefined,
        message: prev.startedAt
          ? `上次运行（启动于 ${prev.startedAt}）未正常退出`
          : '上次运行未正常退出',
      })
    }

    this.writeState({
      cleanExit: false,
      startedAt: new Date().toISOString(),
      version: this.appVersion,
      consecutiveCrashes: consecutiveCrashCount,
    })

    return this.verdict
  }

  /** 正常退出时调用：留下标记，并把连续崩溃计数归零（一次正常退出即视为恢复） */
  markCleanExit(): void {
    const prev = this.readState()
    this.writeState({
      cleanExit: true,
      startedAt: prev?.startedAt || new Date().toISOString(),
      version: this.appVersion,
      consecutiveCrashes: 0,
    })
  }

  /** 记录一次崩溃。时间/版本/平台由此处补齐，调用方只描述崩了什么 */
  record(input: Omit<CrashEvent, 'at' | 'appVersion' | 'platform'>): CrashEvent {
    const event: CrashEvent = {
      at: new Date().toISOString(),
      appVersion: this.appVersion,
      platform: this.platform,
      ...input,
    }
    this.crashesThisRun += 1
    this.appendEvent(event)
    return event
  }

  private appendEvent(event: CrashEvent): void {
    try {
      this.ensureDir()
      fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf-8')
      this.trimIfOversized()
    } catch {
      /* 诊断落盘失败不影响主流程 */
    }
  }

  /** 只在超阈值时才读全文重写，正常路径保持「单行追加」的轻量 */
  private trimIfOversized(): void {
    try {
      if (fs.statSync(this.eventsPath).size <= MAX_EVENT_BYTES) return
      const lines = fs.readFileSync(this.eventsPath, 'utf-8').split('\n').filter(Boolean)
      const kept = lines.slice(-MAX_EVENT_LINES)
      fs.writeFileSync(this.eventsPath, `${kept.join('\n')}\n`, 'utf-8')
    } catch {
      /* 裁剪失败不影响记录 */
    }
  }

  /** 读最近的崩溃事件；损坏的行跳过，不让一行坏数据毁掉整份记录 */
  getRecentEvents(limit = 20): CrashEvent[] {
    try {
      const lines = fs.readFileSync(this.eventsPath, 'utf-8').split('\n').filter(Boolean)
      const events: CrashEvent[] = []
      for (const line of lines.slice(-limit)) {
        try {
          events.push(JSON.parse(line) as CrashEvent)
        } catch {
          /* 跳过损坏行 */
        }
      }
      return events
    } catch {
      return []
    }
  }

  getSummary(limit = 20): CrashSummary {
    return {
      ...this.verdict,
      crashesThisRun: this.crashesThisRun,
      recentEvents: this.getRecentEvents(limit),
    }
  }
}

/** 给数据搬家用：目标目录里的退出标记也改成正常退出，避免把搬家本身报成崩溃 */
export function markCleanExitInDir(
  dir: string,
  appVersion: string,
  platform: string = process.platform,
): void {
  for (const stateFile of [PACKAGED_STATE_FILE, DEV_STATE_FILE]) {
    new CrashRecorder(dir, appVersion, platform, stateFile).markCleanExit()
  }
}
