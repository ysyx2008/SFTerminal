/**
 * 微信 IM 过程消息合并缓冲：累积工具进度 / 中间文本，定时或任务结束时
 * 合并为一条 digest 发出，降低个人号出站频率、缓解 errcode=-2 风控。
 *
 * 不缓冲：最终结果、ask/confirm 卡片、投递失败、任务级错误（由 IMService 直发）。
 */

/** 距首条入队后多久自动 flush（毫秒） */
export const WECHAT_PROGRESS_FLUSH_INTERVAL_MS = 25_000

/** 单条 digest 最多保留的行数，超出则立即 flush 并继续累积 */
export const WECHAT_PROGRESS_MAX_LINES = 12

export type WechatProgressBufferOptions = {
  flushIntervalMs?: number
  maxLines?: number
  header: string
}

export function formatWechatProgressDigest(lines: readonly string[], header: string): string {
  if (lines.length === 0) return ''
  const bullets = lines.map((line) => `· ${line}`).join('\n')
  return `${header}\n${bullets}`
}

export class WechatProgressBuffer {
  private readonly flushIntervalMs: number
  private readonly maxLines: number
  private readonly header: string

  private lines: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private flushChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly send: (text: string) => Promise<void>,
    options: WechatProgressBufferOptions,
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? WECHAT_PROGRESS_FLUSH_INTERVAL_MS
    this.maxLines = options.maxLines ?? WECHAT_PROGRESS_MAX_LINES
    this.header = options.header
  }

  /** 入队一行过程文本；去重与上一条完全相同的连续行 */
  push(line: string): void {
    if (this.disposed) return
    const trimmed = line.trim()
    if (!trimmed) return
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] === trimmed) return

    this.lines.push(trimmed)
    if (this.lines.length >= this.maxLines) {
      void this.flush()
      return
    }
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.disposed || this.timer != null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 立即发送当前缓冲（若无内容则 no-op） */
  flush(): Promise<void> {
    this.clearTimer()
    if (this.disposed || this.lines.length === 0) {
      return this.flushChain
    }

    const text = formatWechatProgressDigest(this.lines, this.header)
    this.lines = []

    const run = async () => {
      await this.send(text)
    }
    this.flushChain = this.flushChain.then(run, run)
    return this.flushChain
  }

  /** 任务结束：取消定时器并 flush 剩余内容 */
  async dispose(): Promise<void> {
    this.clearTimer()
    await this.flush()
    this.disposed = true
    await this.flushChain
  }
}
