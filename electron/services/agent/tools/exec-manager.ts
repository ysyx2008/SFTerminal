/**
 * 后台执行任务管理器
 *
 * 用于支持 exec 工具的"超时转后台"语义。使用 child_process.spawn 启动命令，
 * 挂载 stdout/stderr 监听器持续累积输出到 ring buffer。Agent 后续可以通过
 * await_exec 工具按 task_id 拉取最新输出、等待 pattern 匹配，或主动 kill
 * （`exec("kill <pid>")`）。
 *
 * 关键约束：
 * - 仅供 exec 工具使用（无 PTY 会话），不支持交互式命令
 * - 单个任务输出 ring buffer 上限 1MB（超过截断旧数据）
 * - 任务完成 5 分钟后自动清理（给 Agent 充分时间 await）
 * - max_seconds 到达后 SIGKILL，防止 Agent 启了死循环忘了它
 */
import { spawn, ChildProcess } from 'child_process'
import { decodeBuffer } from '../../../utils/encoding'
import { getDefaultShell } from '../../../utils/platform'
import { createLogger } from '../../../utils/logger'

const log = createLogger('ExecManager')

const RING_BUFFER_MAX = 1_048_576           // 1MB / 任务
const KEEP_AFTER_DONE_MS = 5 * 60 * 1000    // 完成后保留 5 分钟
/** Pattern 匹配时只扫描 buffer 尾部这么多字节（ReDoS 防护：限制最坏匹配时间） */
const PATTERN_SCAN_TAIL_BYTES = 100_000
/** Agent 提供的 pattern 长度上限（再叠加 RegExp 自身复杂度限制即可挡住绝大多数灾难性回溯） */
export const MAX_PATTERN_LENGTH = 200

export type ExecStatus = 'running' | 'completed' | 'failed' | 'killed'

/** 对外快照：纯数据，无进程引用 */
export interface BackgroundExecTaskSnapshot {
  taskId: string
  command: string
  pid: number | undefined
  status: ExecStatus
  startedAt: number
  finishedAt?: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** 完整输出（stdout/stderr 合并按时序，超 1MB 截断旧的） */
  output: string
}

/**
 * Ring buffer：超过 maxLength 时丢弃最早的 chunk（保留尾部最新输出）。
 *
 * chunk 数组实现：每次 append 只 push（O(1)），超额时 shift 旧 chunk
 * 直到回到上限以下。toString() 才做一次 join——避免高频输出场景下
 * 每次 append 都做 O(n) 字符串拷贝（实测 npm run build 这类高频流式
 * 命令，旧实现会触发巨大 GC 压力）。
 */
class RingBuffer {
  private chunks: string[] = []
  private totalLen = 0
  /** toString 缓存：避免同一 buffer 多次 append/notify 之间反复 join */
  private cachedString: string | undefined
  constructor(private readonly maxLength: number) {}

  append(s: string): void {
    if (!s) return
    this.chunks.push(s)
    this.totalLen += s.length
    this.cachedString = undefined
    while (this.totalLen > this.maxLength && this.chunks.length > 0) {
      const removed = this.chunks.shift()!
      this.totalLen -= removed.length
    }
    // 单 chunk 超过上限：截断它本身，保留尾部
    if (this.totalLen > this.maxLength && this.chunks.length === 1) {
      const overflow = this.totalLen - this.maxLength
      this.chunks[0] = this.chunks[0].slice(overflow)
      this.totalLen = this.maxLength
    }
  }

  toString(): string {
    if (this.cachedString === undefined) {
      this.cachedString = this.chunks.join('')
    }
    return this.cachedString
  }

  /** 返回尾部 N 字节（ReDoS 防护：pattern 匹配时只对尾部扫描） */
  tailString(maxBytes: number): string {
    const full = this.toString()
    if (full.length <= maxBytes) return full
    return full.slice(full.length - maxBytes)
  }

  get length(): number { return this.totalLen }
}

interface InternalTask {
  taskId: string
  command: string
  child: ChildProcess
  buffer: RingBuffer
  startedAt: number
  finishedAt?: number
  status: ExecStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  killTimer?: NodeJS.Timeout
  cleanupTimer?: NodeJS.Timeout
  /** 等待者通知列表（数据到达 / 任务结束时触发） */
  waiters: Set<() => void>
}

export type WaitReason = 'done' | 'pattern' | 'timeout' | 'aborted'

export interface SpawnOptions {
  command: string
  cwd?: string
  /** 最长允许运行时间（秒），到点 SIGKILL */
  maxSeconds: number
}

export interface WaitOptions {
  task: InternalTask
  /** 最长等待时长（秒） */
  waitSeconds: number
  /** 命中即返回的正则 */
  pattern?: RegExp
  /** 外部取消信号（每秒检查一次） */
  isAborted?: () => boolean
}

class BackgroundExecManager {
  private tasks = new Map<string, InternalTask>()
  private nextId = 1

  /**
   * 启动命令，立即返回 task 句柄。
   * 注意：成功启动 ≠ 命令成功执行，调用方需通过 wait() 拿状态。
   */
  spawn(opts: SpawnOptions): InternalTask {
    const taskId = `exec-${this.nextId++}`
    const shell = getDefaultShell()

    // Windows 走 cmd shell，POSIX 走 /bin/sh -l -c（与原 exec.ts 行为一致）
    const child = process.platform === 'win32'
      ? spawn(opts.command, { shell, cwd: opts.cwd })
      : spawn(shell, ['-l', '-c', opts.command], { cwd: opts.cwd })

    const buffer = new RingBuffer(RING_BUFFER_MAX)
    const task: InternalTask = {
      taskId,
      command: opts.command,
      child,
      buffer,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      signal: null,
      waiters: new Set(),
    }

    // stdout/stderr 都进同一个 buffer（与同步路径一致：合并按时序输出）
    const onData = (chunk: Buffer) => {
      const text = decodeBuffer(chunk, true).content
      buffer.append(text)
      this.notifyWaiters(task)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('exit', (code, signal) => {
      task.exitCode = code
      task.signal = signal
      task.finishedAt = Date.now()
      if (task.status === 'running') {
        // 信号杀掉视为 killed；exit code 非 0 视为 failed；否则 completed
        task.status = signal ? 'killed' : (code === 0 ? 'completed' : 'failed')
      }
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = undefined
      }
      this.notifyWaiters(task)
      this.scheduleCleanup(task)
    })

    child.on('error', (err) => {
      log.warn(`exec ${taskId} spawn error: ${err.message}`)
      buffer.append(`\n[exec error] ${err.message}\n`)
      // spawn 本身失败（如命令找不到），exit 事件可能不会触发，主动收尾
      if (task.status === 'running') {
        task.status = 'failed'
        task.finishedAt = Date.now()
      }
      this.notifyWaiters(task)
      this.scheduleCleanup(task)
    })

    // max_seconds 安全网：防止 Agent 启了死循环忘了 kill
    task.killTimer = setTimeout(() => {
      if (task.status === 'running') {
        log.info(`exec ${taskId} hit max_seconds (${opts.maxSeconds}s), sending SIGKILL`)
        try { child.kill('SIGKILL') } catch { /* 进程可能已结束 */ }
      }
    }, opts.maxSeconds * 1000)

    this.tasks.set(taskId, task)
    log.info(`exec ${taskId} started, pid=${child.pid}, cmd=${opts.command.slice(0, 80)}`)
    return task
  }

  get(taskId: string): InternalTask | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * 等待任务完成、命中 pattern、超时或被取消。
   *
   * 立即检查一次（任务可能已结束、pattern 可能已命中）；否则注册 waiter，
   * 在数据到达或任务结束时被通知。
   *
   * pattern 匹配仅扫描 buffer 尾部 PATTERN_SCAN_TAIL_BYTES（100KB），
   * 防止灾难性回溯 + 限制最坏匹配时间——即使 LLM 给了不太好的 regex 也不会卡死。
   */
  async wait(opts: WaitOptions): Promise<WaitReason> {
    const { task, waitSeconds, pattern, isAborted } = opts

    const matchPattern = (): boolean =>
      pattern ? pattern.test(task.buffer.tailString(PATTERN_SCAN_TAIL_BYTES)) : false

    if (task.status !== 'running') return 'done'
    if (matchPattern()) return 'pattern'
    if (isAborted?.()) return 'aborted'

    return new Promise<WaitReason>((resolve) => {
      let settled = false
      const settle = (reason: WaitReason) => {
        if (settled) return
        settled = true
        task.waiters.delete(notify)
        clearTimeout(timer)
        if (abortChecker) clearInterval(abortChecker)
        resolve(reason)
      }
      const notify = () => {
        if (task.status !== 'running') return settle('done')
        if (matchPattern()) return settle('pattern')
      }
      task.waiters.add(notify)
      const timer = setTimeout(() => settle('timeout'), waitSeconds * 1000)
      // 取消信号无事件源，秒级轮询足够（Agent abort 不要求毫秒级响应）
      const abortChecker: NodeJS.Timeout | undefined = isAborted
        ? setInterval(() => { if (isAborted()) settle('aborted') }, 1000)
        : undefined

      // TOCTOU 二次检查：进程可能在「立即检查」与「task.waiters.add」之间退出，
      // 那种情况下 exit 事件已经触发过 notifyWaiters，但当时 notify 还没注册，
      // 会一直等到 timer 超时。这里再检查一次状态/pattern，把这个边界关掉。
      if (task.status !== 'running') return settle('done')
      if (matchPattern()) return settle('pattern')
    })
  }

  /**
   * 主动杀掉运行中的任务。返回是否实际发出信号。
   * 只供 Agent abort 流程内部使用——日常 kill 让 Agent 通过 `exec("kill <pid>")` 完成。
   */
  kill(taskId: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return false
    try {
      task.child.kill(signal)
      return true
    } catch {
      return false
    }
  }

  list(): BackgroundExecTaskSnapshot[] {
    return Array.from(this.tasks.values()).map(t => this.snapshot(t))
  }

  snapshot(task: InternalTask): BackgroundExecTaskSnapshot {
    return {
      taskId: task.taskId,
      command: task.command,
      pid: task.child.pid,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      signal: task.signal,
      output: task.buffer.toString(),
    }
  }

  /**
   * 测试用：清掉所有 timer、SIGKILL 所有子进程、清空 Map。生产代码勿用。
   *
   * SIGKILL 是必要的：测试间残留的子进程会污染下一个测试的 PID/输出，
   * 也会让 vitest 整体挂起等不到 worker 退出。
   */
  _resetForTest(): void {
    for (const task of this.tasks.values()) {
      if (task.killTimer) clearTimeout(task.killTimer)
      if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
      try { task.child.kill('SIGKILL') } catch { /* ignore */ }
    }
    this.tasks.clear()
    this.nextId = 1
  }

  private notifyWaiters(task: InternalTask): void {
    // 复制一份避免回调里 delete 影响迭代
    const snapshot = Array.from(task.waiters)
    for (const fn of snapshot) fn()
  }

  private scheduleCleanup(task: InternalTask): void {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer)
    task.cleanupTimer = setTimeout(() => {
      this.tasks.delete(task.taskId)
      log.info(`exec ${task.taskId} cleaned up after ${KEEP_AFTER_DONE_MS / 1000}s`)
    }, KEEP_AFTER_DONE_MS)
    // 让 cleanup timer 不阻塞进程退出
    task.cleanupTimer.unref?.()
  }

  /**
   * 进程退出钩子：杀掉所有运行中任务，避免孤儿。
   */
  killAllOnShutdown(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        try { task.child.kill('SIGTERM') } catch { /* ignore */ }
      }
    }
  }
}

let instance: BackgroundExecManager | undefined

export function getExecManager(): BackgroundExecManager {
  if (!instance) {
    instance = new BackgroundExecManager()
    process.once('beforeExit', () => instance?.killAllOnShutdown())
  }
  return instance
}

// 仅导出类型供其他模块使用，不导出 InternalTask
export type { InternalTask as BackgroundExecTask }
