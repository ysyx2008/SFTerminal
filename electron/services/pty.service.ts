import * as pty from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import * as os from 'os'

export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
}

export interface CommandResult {
  output: string
  exitCode: number
  duration: number
  aborted?: boolean
}

interface PtyInstance {
  pty: pty.IPty
  dataCallbacks: ((data: string) => void)[]
  disposed: boolean
}

// 用于追踪正在执行的命令
interface PendingCommand {
  markerId: string
  resolve: (result: CommandResult) => void
  reject: (error: Error) => void
  startTime: number
  output: string
  collecting: boolean
  timeoutId?: NodeJS.Timeout
}

export class PtyService {
  private instances: Map<string, PtyInstance> = new Map()
  // 追踪正在执行的命令（按 ptyId 分组）
  private pendingCommands: Map<string, PendingCommand> = new Map()

  // 标记前缀，使用特殊 Unicode 字符降低冲突概率
  private readonly MARKER_PREFIX = '⟦AGENT:'
  private readonly MARKER_SUFFIX = '⟧'

  /**
   * 获取默认 Shell
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/bash'
  }

  /**
   * 创建新的 PTY 实例
   */
  create(options: PtyOptions = {}): string {
    const id = uuidv4()

    const shell = options.shell || this.getDefaultShell()
    const cwd = options.cwd || os.homedir()
    const cols = options.cols || 80
    const rows = options.rows || 24

    // 合并环境变量
    const env = {
      ...process.env,
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    } as Record<string, string>

    // 创建 PTY
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const instance: PtyInstance = {
      pty: ptyProcess,
      dataCallbacks: [],
      disposed: false
    }

    // 监听数据输出
    ptyProcess.onData((data: string) => {
      // 如果已销毁，不再触发回调
      if (instance.disposed) return
      instance.dataCallbacks.forEach(callback => {
        try {
          callback(data)
        } catch (e) {
          // 忽略回调错误（如 EPIPE）
        }
      })
    })

    // 监听退出
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`PTY ${id} exited with code ${exitCode}`)
      this.instances.delete(id)
    })

    this.instances.set(id, instance)
    return id
  }

  /**
   * 向 PTY 写入数据
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.write(data)
    }
  }

  /**
   * 调整 PTY 大小
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.resize(cols, rows)
    }
  }

  /**
   * 注册数据回调
   */
  onData(id: string, callback: (data: string) => void): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.dataCallbacks.push(callback)
    }
  }

  /**
   * 销毁 PTY 实例
   */
  dispose(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      // 标记为已销毁，防止后续回调触发
      instance.disposed = true
      instance.dataCallbacks = []
      try {
        instance.pty.kill()
      } catch (e) {
        // 忽略 kill 时的错误
      }
      this.instances.delete(id)
    }
  }

  /**
   * 销毁所有 PTY 实例
   */
  disposeAll(): void {
    this.instances.forEach((instance, id) => {
      instance.disposed = true
      instance.dataCallbacks = []
      try {
        instance.pty.kill()
      } catch (e) {
        // 忽略 kill 时的错误
      }
      this.instances.delete(id)
    })
    // 清理所有待执行命令
    this.pendingCommands.forEach((cmd) => {
      if (cmd.timeoutId) clearTimeout(cmd.timeoutId)
      cmd.reject(new Error('PTY disposed'))
    })
    this.pendingCommands.clear()
  }

  /**
   * 生成唯一标记 ID
   */
  private generateMarkerId(): string {
    return Math.random().toString(36).substring(2, 10)
  }

  /**
   * 构建带标记的命令
   * 使用暗淡颜色使标记不那么显眼，同时方便解析
   */
  private buildWrappedCommand(command: string, markerId: string): string {
    const startMarker = `${this.MARKER_PREFIX}S:${markerId}${this.MARKER_SUFFIX}`
    const endMarker = `${this.MARKER_PREFIX}E:${markerId}:$?${this.MARKER_SUFFIX}`
    
    // 根据 shell 类型构建命令
    // 对于 bash/zsh，使用 $'\e[2m' 语法显示暗淡颜色
    // 暂时简化处理，不使用颜色以确保兼容性
    if (process.platform === 'win32') {
      // PowerShell
      return `echo '${startMarker}'; ${command}; echo '${this.MARKER_PREFIX}E:${markerId}:'$LASTEXITCODE'${this.MARKER_SUFFIX}'\r`
    } else {
      // Bash/Zsh
      return `echo '${startMarker}' && ${command}; echo '${this.MARKER_PREFIX}E:${markerId}:'$?'${this.MARKER_SUFFIX}'\n`
    }
  }

  /**
   * 在当前终端会话中执行命令并等待结果
   * @param id PTY 实例 ID
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒），默认 30000
   */
  executeCommand(id: string, command: string, timeout: number = 30000): Promise<CommandResult> {
    const instance = this.instances.get(id)
    if (!instance) {
      return Promise.reject(new Error(`PTY instance ${id} not found`))
    }

    const markerId = this.generateMarkerId()
    const wrappedCommand = this.buildWrappedCommand(command, markerId)
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      // 创建待执行命令记录
      const pendingCmd: PendingCommand = {
        markerId,
        resolve,
        reject,
        startTime,
        output: '',
        collecting: false
      }

      // 设置超时
      pendingCmd.timeoutId = setTimeout(() => {
        this.pendingCommands.delete(id)
        resolve({
          output: pendingCmd.output,
          exitCode: -1,
          duration: Date.now() - startTime,
          aborted: true
        })
      }, timeout)

      // 注册命令
      this.pendingCommands.set(id, pendingCmd)

      // 注册输出处理器
      const outputHandler = (data: string) => {
        this.handleCommandOutput(id, data)
      }
      
      // 添加临时回调用于处理命令输出
      instance.dataCallbacks.push(outputHandler)

      // 发送命令
      instance.pty.write(wrappedCommand)
    })
  }

  /**
   * 处理命令输出，检测标记并收集输出
   */
  private handleCommandOutput(ptyId: string, data: string): void {
    const pendingCmd = this.pendingCommands.get(ptyId)
    if (!pendingCmd) return

    const startPattern = `${this.MARKER_PREFIX}S:${pendingCmd.markerId}${this.MARKER_SUFFIX}`
    const endPattern = new RegExp(
      `${this.escapeRegExp(this.MARKER_PREFIX)}E:${pendingCmd.markerId}:(\\d+)${this.escapeRegExp(this.MARKER_SUFFIX)}`
    )

    // 累积数据
    pendingCmd.output += data

    // 检查是否开始收集
    if (!pendingCmd.collecting) {
      const startIdx = pendingCmd.output.indexOf(startPattern)
      if (startIdx !== -1) {
        pendingCmd.collecting = true
        // 移除开始标记之前的内容（包括标记本身）
        pendingCmd.output = pendingCmd.output.substring(startIdx + startPattern.length)
      }
    }

    // 检查是否结束
    if (pendingCmd.collecting) {
      const match = pendingCmd.output.match(endPattern)
      if (match) {
        const exitCode = parseInt(match[1], 10)
        // 移除结束标记及其后的内容
        const endIdx = pendingCmd.output.indexOf(match[0])
        const output = pendingCmd.output.substring(0, endIdx)

        // 清理
        if (pendingCmd.timeoutId) {
          clearTimeout(pendingCmd.timeoutId)
        }
        this.pendingCommands.delete(ptyId)

        // 清理输出中的换行符和多余空白
        const cleanOutput = this.cleanOutput(output)

        // 返回结果
        pendingCmd.resolve({
          output: cleanOutput,
          exitCode,
          duration: Date.now() - pendingCmd.startTime
        })
      }
    }
  }

  /**
   * 清理命令输出
   */
  private cleanOutput(output: string): string {
    return output
      // 移除 ANSI 转义序列
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // 移除回车符
      .replace(/\r/g, '')
      // 移除开头和结尾的空白行
      .trim()
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 中止正在执行的命令
   */
  abortCommand(id: string): boolean {
    const pendingCmd = this.pendingCommands.get(id)
    if (!pendingCmd) return false

    if (pendingCmd.timeoutId) {
      clearTimeout(pendingCmd.timeoutId)
    }

    this.pendingCommands.delete(id)

    pendingCmd.resolve({
      output: pendingCmd.output,
      exitCode: -1,
      duration: Date.now() - pendingCmd.startTime,
      aborted: true
    })

    // 发送 Ctrl+C 中止当前命令
    const instance = this.instances.get(id)
    if (instance) {
      instance.pty.write('\x03')
    }

    return true
  }

  /**
   * 检查是否有命令正在执行
   */
  isCommandPending(id: string): boolean {
    return this.pendingCommands.has(id)
  }
}

