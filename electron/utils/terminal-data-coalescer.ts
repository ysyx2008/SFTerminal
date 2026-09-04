/**
 * 把高频终端输出攒成少量下发，避免每个数据包都打一次 IPC、冲死窗口消息泵。
 * 交互输入仍是一两个包，最多晚一帧；海量刷屏时把成千上万次发送收成每帧一次。
 */

export const TERMINAL_IPC_FLUSH_MS = 8
export const TERMINAL_IPC_FLUSH_CHARS = 64 * 1024

export interface TerminalDataCoalescer {
  push(data: string): void
  flush(): void
  dispose(): void
}

export function createTerminalDataCoalescer(
  send: (data: string) => void
): TerminalDataCoalescer {
  const chunks: string[] = []
  let chars = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (chunks.length === 0) return
    const out = chunks.join('')
    chunks.length = 0
    chars = 0
    try {
      send(out)
    } catch {
      // 窗口关闭竞态：isDestroyed 通过后 send 仍可能抛
    }
  }

  const push = (data: string) => {
    if (disposed || !data) return
    chunks.push(data)
    chars += data.length
    if (chars >= TERMINAL_IPC_FLUSH_CHARS) {
      flush()
      return
    }
    if (!timer) {
      timer = setTimeout(flush, TERMINAL_IPC_FLUSH_MS)
    }
  }

  const dispose = () => {
    disposed = true
    flush()
  }

  return { push, flush, dispose }
}
