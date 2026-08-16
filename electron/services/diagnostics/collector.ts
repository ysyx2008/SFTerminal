/**
 * 崩溃采集接入 —— 把平台给出的崩溃信号接到崩溃记录上
 *
 * 两个时机约束：
 * - 必须在 app ready 之前调用，否则启动早期的崩溃收不住；
 * - 必须在 userData 重定向之后调用，否则崩溃转储落到旧数据目录。
 *
 * 设计目标见 SPEC.md。
 */
import { app, BrowserWindow, crashReporter } from 'electron'
import * as path from 'path'
import { CrashRecorder, type CrashEvent } from './crash-recorder'
import { createLogger } from '../../utils/logger'

const log = createLogger('Diagnostics')

/**
 * 哪些退出原因算崩溃。这里匹配的是 Electron 的固定枚举值，不是对自然语言的猜测。
 *
 * `clean-exit` 是正常收摊。`killed` 排除掉是因为我们自己就会主动杀工具进程
 * （嵌入 worker 定期重启、语音 worker 关闭都走 kill），把它算成崩溃会让统计失真；
 * 宁可漏掉被系统杀掉的极少数，也不能让用户看到假的崩溃提示。
 */
const NON_CRASH_REASONS = new Set(['clean-exit', 'killed'])

export function isCrashReason(reason: string): boolean {
  return !NON_CRASH_REASONS.has(reason)
}

/**
 * 子进程崩溃的可读身份。
 *
 * 注意 Electron 对所有 Node 工具进程上报的 serviceName 都是同一个 mojo 服务名，
 * 想区分「是嵌入还是语音崩的」得靠 name（fork 时命名）。两者都可能缺，
 * 所以原始三元组另行完整记入事件，这里只挑一个最可读的做展示。
 */
export function describeChildProcess(details: {
  type: string
  name?: string
  serviceName?: string
}): string {
  return details.name || details.serviceName || details.type
}

let recorder: CrashRecorder | null = null
/** 崩溃发生时通知外部（提示层在后续步骤接入） */
const listeners = new Set<(event: CrashEvent) => void>()

function emit(event: CrashEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* 提示失败不影响记录 */
    }
  }
}

export function onCrashRecorded(listener: (event: CrashEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCrashRecorder(): CrashRecorder | null {
  return recorder
}

/** 崩溃转储目录（Crashpad 落 minidump 的地方，事后可用它还原崩溃栈） */
export function getCrashDumpDir(): string {
  return app.getPath('crashDumps')
}

/** 记录一次崩溃并通知监听者。recorder 未就绪时静默忽略，不让诊断影响主流程 */
function recordCrash(input: Omit<CrashEvent, 'at' | 'appVersion' | 'platform'>): void {
  if (!recorder) return
  const event = recorder.record(input)
  log.error(
    `崩溃事件: kind=${event.kind} process=${event.processType ?? '-'} ` +
    `service=${event.serviceName ?? '-'} reason=${event.reason ?? '-'} exitCode=${event.exitCode ?? '-'}`
  )
  emit(event)
}

let reporterStarted = false

/**
 * 只开崩溃转储，不产生任何状态副作用，所以可以在启动的最早期调用——
 * 不开就完全没有 minidump，原生崩溃将无从追查。
 *
 * uploadToServer:false：本版不接服务端，转储留在本机由用户主动交出。
 */
export function startCrashReporter(): void {
  if (reporterStarted) return
  reporterStarted = true
  try {
    crashReporter.start({ uploadToServer: false, compress: true })
  } catch (err) {
    log.warn('崩溃转储启动失败，将只有事件记录没有转储:', err)
  }
}

/**
 * 崩溃记录与事件监听。
 *
 * 必须等确认拿到单实例锁之后再调用：抢不到锁的第二个实例马上就会退出，
 * 若让它也走一遍启动/退出标记，就会读到正在运行实例的「运行中」标记而误判
 * 上次崩溃，还会把真实实例的连续崩溃计数抹平——统计从根上就失真了。
 */
export function initCrashDiagnostics(): CrashRecorder {
  if (recorder) return recorder

  startCrashReporter()
  recorder = new CrashRecorder(path.join(app.getPath('userData'), 'diagnostics'), app.getVersion())

  const verdict = recorder.markStartup()
  if (verdict.lastExitWasCrash) {
    log.warn(
      `上次运行异常退出（连续 ${verdict.consecutiveCrashCount} 次，上次版本 ${verdict.previousVersion ?? '未知'}）`
    )
  }

  // 界面进程消失。崩的可能是窗口本身，也可能是产出物预览这类嵌入内容
  // （webview 的 guest 有独立渲染进程）。后者在用户眼里只是「预览坏了」，
  // 按整个界面崩溃处理会误伤——提示措辞不对，去重载主窗口更会白白清掉用户的现场。
  app.on('render-process-gone', (_event, webContents, details) => {
    if (!isCrashReason(details.reason)) return
    const owner = BrowserWindow.fromWebContents(webContents)
    const isWindowItself = owner !== null && owner.webContents.id === webContents.id
    recordCrash({
      kind: 'renderer-gone',
      processType: isWindowItself ? 'renderer' : 'webview',
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  // 子进程消失：GPU 与各工具进程（嵌入 / 向量库 / 语音 / 文档解析 / 预览）
  app.on('child-process-gone', (_event, details) => {
    if (!isCrashReason(details.reason)) return
    recordCrash({
      kind: 'child-gone',
      processType: details.type,
      serviceName: describeChildProcess(details),
      reason: details.reason,
      exitCode: details.exitCode,
      // 身份字段各有缺失可能，原样留全，避免事后想区分具体进程时无据可查
      message: `type=${details.type} name=${details.name ?? '-'} serviceName=${details.serviceName ?? '-'}`,
    })
  })

  // 正常退出的唯一标记点：进程被强杀时不会走到这里，那恰好就是「上次是崩的」的依据
  app.on('quit', () => {
    recorder?.markCleanExit()
  })

  // 诊断绝不能挡住启动，连这行日志里的路径查询也一并防住
  try {
    log.info(`崩溃诊断已就绪（转储目录 ${getCrashDumpDir()}）`)
  } catch {
    /* ignore */
  }
  return recorder
}

/** 主进程 JS 异常兼记为崩溃事件（现有 handler 只写日志，日志里翻不出统计） */
export function recordMainProcessError(kind: 'main-uncaught' | 'main-unhandled', message: string): void {
  recordCrash({ kind, processType: 'browser', message })
}
