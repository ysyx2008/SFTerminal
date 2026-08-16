/**
 * 摘要用的崩前日志窗口
 *
 * 补报上次异常退出时，同一天的日志文件里已经写上了这次启动的内容。
 * 若只取文件尾，摘要会变成「连 MCP 失败」这类重启后噪音，把真正的崩前现场盖掉。
 */

/** 摘要里带的行数：够看出崩在哪一步，又不至于让人粘不出去 */
export const SUMMARY_LOG_LINES = 30
/** 单行上限：MCP 等会把整段 Java 堆栈打进一行 */
export const SUMMARY_LOG_LINE_MAX = 240

export interface LogTimeWindow {
  /** 上次运行启动（含） */
  from?: string
  /** 这次启动 / 补报时刻（不含） */
  to: string
}

export function truncateLogLine(line: string, max = SUMMARY_LOG_LINE_MAX): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)}…`
}

/**
 * 从一行日志里取出时间。格式来自本应用自己的日志约定，不是对任意文本猜时间。
 * 只有时刻、没有日期时，用日志文件名上的日期（本地时区）。
 */
export function parseLogLineTime(line: string, fileDate?: string): number | null {
  const appStarted = line.match(/App Started \| v\S+ \| (\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)/)
  if (appStarted) {
    const ms = Date.parse(appStarted[1])
    if (!Number.isNaN(ms)) return ms
  }

  const full = line.match(/^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/)
  if (full) {
    const ms = Date.parse(`${full[1]}T${full[2]}`)
    if (!Number.isNaN(ms)) return ms
  }

  const timeOnly = line.match(/^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/)
  if (timeOnly && fileDate) {
    const ms = Date.parse(`${fileDate}T${timeOnly[1]}`)
    if (!Number.isNaN(ms)) return ms
  }

  return null
}

export function selectLogLines(
  chunks: Array<{ text: string; fileDate?: string }>,
  options: { window?: LogTimeWindow; limit?: number } = {}
): string[] {
  const limit = options.limit ?? SUMMARY_LOG_LINES
  const lines: Array<{ text: string; time: number | null }> = []
  for (const chunk of chunks) {
    for (const raw of chunk.text.split('\n')) {
      if (!raw) continue
      lines.push({ text: raw, time: parseLogLineTime(raw, chunk.fileDate) })
    }
  }

  const windowed = options.window
    ? takeWindow(lines, options.window)
    : lines

  return windowed.slice(-limit).map(line => truncateLogLine(line.text))
}

function takeWindow(
  lines: Array<{ text: string; time: number | null }>,
  window: LogTimeWindow
): Array<{ text: string; time: number | null }> {
  // 这次启动的 App Started 是硬边界：它可能比补报时间戳更早，单靠时间窗会漏进新进程第一行
  const beforeStart = fallbackBeforeAppStarted(lines)
  const pool = beforeStart.length > 0 ? beforeStart : lines

  const to = Date.parse(window.to)
  const from = window.from ? Date.parse(window.from) : Number.NaN
  if (Number.isNaN(to)) return beforeStart

  const inWindow: Array<{ text: string; time: number | null }> = []
  let lastTime: number | null = null
  for (const line of pool) {
    const time = line.time ?? lastTime
    if (line.time !== null) lastTime = line.time
    if (time === null) continue
    if (!Number.isNaN(from) && time < from) continue
    if (time >= to) continue
    inWindow.push(line)
  }

  return inWindow.length > 0 ? inWindow : beforeStart
}

/** 时间戳对不上时：用这次启动的「App Started」当界，取它前面的行 */
function fallbackBeforeAppStarted(
  lines: Array<{ text: string; time: number | null }>
): Array<{ text: string; time: number | null }> {
  let lastStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text.includes('========== App Started')) lastStart = i
  }
  if (lastStart <= 0) return []
  return lines.slice(0, lastStart)
}
