/**
 * 终端采集净化：丢掉连续大段空字节，并给采集环缓一个上限。
 * 空格 / 换行 / Tab 不动；只砍连续很长的 NUL。
 */

/** 连续至少这么多个 NUL 才收缩（UTF-16 间隔 NUL 不会被误伤） */
export const CONSECUTIVE_NUL_COLLAPSE_MIN = 256

/** 采集安全上限：先收缩空字节，仍超长才留尾。正常长日志走事后外化。 */
export const TERMINAL_CAPTURE_MAX_CHARS = 2_000_000

const NUL_RUN = new RegExp(`\\0{${CONSECUTIVE_NUL_COLLAPSE_MIN},}`, 'g')

export function collapseConsecutiveNuls(
  text: string,
  minRun: number = CONSECUTIVE_NUL_COLLAPSE_MIN,
): string {
  if (!text.includes('\0')) return text
  if (minRun === CONSECUTIVE_NUL_COLLAPSE_MIN) {
    return text.replace(NUL_RUN, '')
  }
  return text.replace(new RegExp(`\\0{${minRun},}`, 'g'), '')
}

/** 先收缩本段空字节，再接到环缓尾部，超出则只留尾巴。 */
export function appendCappedTerminalOutput(
  current: string,
  chunk: string,
  maxChars: number = TERMINAL_CAPTURE_MAX_CHARS,
): string {
  const cleaned = collapseConsecutiveNuls(chunk)
  if (!cleaned) {
    return current.length > maxChars ? current.slice(-maxChars) : current
  }
  const clipped = cleaned.length > maxChars ? cleaned.slice(-maxChars) : cleaned
  if (current.length + clipped.length <= maxChars) return current + clipped
  return (current + clipped).slice(-maxChars)
}
