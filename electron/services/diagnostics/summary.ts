/**
 * 崩溃摘要 —— 一段能直接粘进聊天窗口的纯文本
 *
 * 这是用户交出现场的主动作：门槛低到一次粘贴，比让他翻目录找几百兆的包实际得多。
 * 内容取舍的标准是「能不能让崩溃可归类」——所以退出码要翻译成人能懂的性质
 * （原生内存错误 vs 程序逻辑异常），子进程要说清是哪一个。
 *
 * 文本本身是给开发者看的诊断数据，不是界面文案，不进 i18n。
 */
import type { CrashEvent, CrashKind, CrashSummary } from '@sailfish/shared-types'
import type { Redactor } from './redact'

export interface DiagnosticsEnv {
  appVersion: string
  platform: string
  /** 操作系统版本号 */
  osRelease: string
  arch: string
  totalMemoryMb: number
  /** 硬件加速与合成状态概述 */
  gpuStatus?: string
  /** 显卡与驱动 */
  gpuDevice?: string
  /** 是否把数据目录搬到了自定义位置 */
  customDataDir: boolean
}

export interface CrashSummaryTextInput {
  env: DiagnosticsEnv
  crash: CrashSummary
  /** 崩溃前的少量日志（补报上次退出时必须是上次运行时间窗内的） */
  recentLogLines?: string[]
  /** 最新的崩溃转储文件名 */
  latestDumpName?: string
  /** 从转储读出的崩溃性质（内存耗尽、异常码等） */
  dumpHints?: string
}

/**
 * Windows 常见异常码。取的是 NTSTATUS 固定值，属于系统协议常量，
 * 不是对错误文本的关键词猜测。有了它，「用户说崩了」才能变成可归类的证据。
 */
const EXCEPTION_CODES: Record<string, string> = {
  '0xc0000005': '访问违例（原生内存错误，不是 JS 异常）',
  '0xc0000374': '堆损坏（原生内存错误）',
  '0xc00000fd': '栈溢出',
  '0xc0000409': '栈缓冲区溢出',
  '0xc000041d': '回调中发生未处理异常',
  '0x80000003': '触发断点',
}

export function describeExitCode(code?: number): string {
  if (code === undefined || code === null) return '-'
  if (code >= 0) return String(code)
  // 负数是被当成有符号数读的 Windows 异常码，还原成无符号十六进制才能查表
  const hex = `0x${(code >>> 0).toString(16)}`
  const known = EXCEPTION_CODES[hex]
  return known ? `${code} (${hex} ${known})` : `${code} (${hex})`
}

const KIND_LABELS: Record<CrashKind, string> = {
  'main-uncaught': '主进程未捕获异常',
  'main-unhandled': '主进程未处理的 Promise 拒绝',
  'renderer-gone': '界面进程崩溃',
  'child-gone': '子进程崩溃',
  'previous-exit': '上次运行异常退出',
}

export function describeCrashKind(kind: CrashKind): string {
  return KIND_LABELS[kind] ?? kind
}

function describeEvent(event: CrashEvent): string {
  const parts = [describeCrashKind(event.kind)]
  if (event.serviceName) {
    parts.push(`(${event.serviceName})`)
  } else if (event.processType) {
    parts.push(`(${event.processType})`)
  }
  return parts.join(' ')
}

export function buildCrashSummaryText(input: CrashSummaryTextInput, redact: Redactor): string {
  const { env, crash } = input
  // 最后一条最贴近用户此刻的问题
  const primary = crash.recentEvents.at(-1)

  const lines: string[] = [
    'SailFish 崩溃报告',
    `版本: ${env.appVersion} (${env.platform} ${env.osRelease} ${env.arch})`,
    `生成时间: ${new Date().toISOString()}`,
  ]

  if (primary) {
    lines.push(`类型: ${describeEvent(primary)}`)
    lines.push(`发生于: ${primary.at}`)
    if (primary.reason) lines.push(`原因: ${primary.reason}`)
    lines.push(`退出码: ${describeExitCode(primary.exitCode)}`)
    if (primary.message) lines.push(`补充: ${redact(primary.message)}`)
  } else {
    lines.push('类型: 未记录到崩溃事件')
  }

  lines.push(
    `本次运行崩溃: ${crash.crashesThisRun} 次 | 连续异常退出: ${crash.consecutiveCrashCount} 次`
  )
  if (crash.lastExitWasCrash) {
    lines.push(`上次未正常退出，上次运行版本: ${crash.previousVersion ?? '未知'}`)
  }
  lines.push(`内存: ${env.totalMemoryMb} MB${env.customDataDir ? ' | 数据目录已自定义' : ''}`)
  if (env.gpuDevice) lines.push(`显卡: ${env.gpuDevice}`)
  if (env.gpuStatus) lines.push(`图形: ${env.gpuStatus}`)
  if (crash.dumpCount !== undefined) {
    lines.push(
      `崩溃转储: ${crash.dumpCount} 个` +
      (input.latestDumpName ? `，最新 ${input.latestDumpName}（保存在本机，可另行提供）` : '')
    )
  }
  if (input.dumpHints) {
    lines.push(`转储标注: ${input.dumpHints}`)
  }

  // 同类事件反复出现是判断「是否普遍」的关键，逐条列出比只给一条有用
  const others = crash.recentEvents.slice(-6, -1)
  if (others.length > 0) {
    lines.push('', '此前的崩溃事件:')
    for (const event of others) {
      lines.push(`  ${event.at} ${describeEvent(event)} ${event.reason ?? ''}`.trimEnd())
    }
  }

  const logLines = input.recentLogLines ?? []
  if (logLines.length > 0) {
    const previousExit = crash.recentEvents.at(-1)?.kind === 'previous-exit'
    lines.push('', previousExit ? '崩溃前日志（上次运行）:' : '最近日志:')
    for (const line of logLines) {
      lines.push(`  ${redact(line)}`)
    }
  }

  return lines.join('\n')
}
