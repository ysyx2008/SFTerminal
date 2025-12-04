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
   * 使用不可见的方式添加标记：
   * 1. 先执行实际命令（用户看到的）
   * 2. 使用 ANSI 转义序列隐藏标记输出
   */
  private buildWrappedCommand(command: string, markerId: string): string {
    const startMarker = `${this.MARKER_PREFIX}S:${markerId}${this.MARKER_SUFFIX}`
    const endMarker = `${this.MARKER_PREFIX}E:${markerId}`
    
    // 使用 ANSI 隐藏序列：\x1b[8m 隐藏文本，\x1b[28m 取消隐藏
    // 或者使用极暗的颜色 \x1b[2m (dim) + \x1b[30m (black)
    const hide = '\\x1b[2m\\x1b[30m'
    const show = '\\x1b[0m'
    
    if (process.platform === 'win32') {
      // PowerShell - 暂时保持原样
      return `echo '${startMarker}'; ${command}; echo '${endMarker}:'$LASTEXITCODE'${this.MARKER_SUFFIX}'\r`
    } else {
      // Bash/Zsh - 使用 printf 输出隐藏的标记
      // 先输出隐藏的开始标记，然后执行命令，最后输出隐藏的结束标记
      return `printf '${hide}${startMarker}${show}\\n' && ${command}; printf '${hide}${endMarker}:'$?'${this.MARKER_SUFFIX}${show}\\n'\n`
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

  /**
   * 在终端执行命令并收集输出
   * 使用 OSC 133 Shell Integration 标记精确检测命令完成
   */
  executeInTerminal(
    id: string, 
    command: string, 
    timeout: number = 30000
  ): Promise<{ output: string; duration: number; exitCode?: number }> {
    return new Promise((resolve) => {
      const instance = this.instances.get(id)
      if (!instance) {
        resolve({ output: '终端实例不存在', duration: 0 })
        return
      }

      const startTime = Date.now()
      let output = ''
      let timeoutTimer: NodeJS.Timeout | null = null
      let resolved = false
      let exitCode: number | undefined

      // 生成唯一标记 ID
      const markerId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      
      // OSC 133 序列（FinalTerm/iTerm2/VS Code 标准）
      // C = 命令开始执行
      // D = 命令执行完成，后面跟退出码
      const OSC_START = `\x1b]133;C;id=${markerId}\x07`
      const OSC_END_PATTERN = new RegExp(`\x1b\\]133;D;(\\d+);id=${markerId}\x07`)
      
      // 备用：提示符检测（如果 OSC 不工作）
      const promptPatterns = [
        /[$#%>❯➜»⟩›]\s*$/,
        /\n[^\n]*[$#%>❯➜»⟩›]\s*$/,
      ]
      const isPrompt = (text: string): boolean => {
        const lastLine = text.split(/[\r\n]/).filter(l => l.trim()).pop() || ''
        return promptPatterns.some(p => p.test(lastLine) || p.test(text.slice(-50)))
      }

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        const idx = instance.dataCallbacks.indexOf(outputHandler)
        if (idx !== -1) {
          instance.dataCallbacks.splice(idx, 1)
        }
      }

      const finish = () => {
        if (resolved) return
        resolved = true
        cleanup()
        
        // 清理输出
        let cleanOutput = output
        
        // 移除 OSC 序列
        cleanOutput = cleanOutput.replace(/\x1b\]133;[^;]*;[^\x07]*\x07/g, '')
        cleanOutput = cleanOutput.replace(/\x1b\]133;[^\x07]*\x07/g, '')
        
        // 移除命令回显（第一行）
        const lines = cleanOutput.split(/\r?\n/)
        if (lines.length > 0) {
          // 查找并移除包含原始命令的行
          const cmdStart = command.slice(0, Math.min(20, command.length))
          const cmdIdx = lines.findIndex(l => l.includes(cmdStart))
          if (cmdIdx !== -1 && cmdIdx < 3) {
            lines.splice(0, cmdIdx + 1)
          }
        }
        
        // 移除尾部空行和提示符
        while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || isPrompt(lines[lines.length - 1]))) {
          lines.pop()
        }
        cleanOutput = lines.join('\n')
        
        resolve({
          output: cleanOutput.trim(),
          duration: Date.now() - startTime,
          exitCode
        })
      }

      let commandStarted = false
      let lastOutputTime = Date.now()

      // 输出处理器
      const outputHandler = (data: string) => {
        output += data
        lastOutputTime = Date.now()
        
        // 检测 OSC 133 D 序列（命令完成）
        const match = output.match(OSC_END_PATTERN)
        if (match) {
          exitCode = parseInt(match[1], 10)
          // 稍等一下确保所有输出都收到
          setTimeout(finish, 50)
          return
        }
        
        // 备用：检测提示符（如果 shell 不支持 OSC 133）
        if (commandStarted && isPrompt(output)) {
          setTimeout(() => {
            // 如果 200ms 内没有新输出且仍然是提示符，认为命令完成
            if (Date.now() - lastOutputTime >= 150 && isPrompt(output)) {
              finish()
            }
          }, 200)
        }
      }

      // 添加输出监听器
      instance.dataCallbacks.push(outputHandler)

      // 设置总超时
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          output += '\n[命令执行超时]'
          finish()
        }
      }, timeout)

      // 构建带 OSC 标记的命令
      // 使用 printf 输出 OSC 序列，兼容性更好
      const wrappedCommand = `printf '${OSC_START.replace(/'/g, "'\\''")}' 2>/dev/null; ${command}; __exit_code=$?; printf '\x1b]133;D;%d;id=${markerId}\x07' $__exit_code 2>/dev/null; exit $__exit_code 2>/dev/null || true`
      
      // 发送命令
      instance.pty.write(wrappedCommand + '\n')
      
      // 标记命令已开始
      setTimeout(() => {
        commandStarted = true
      }, 100)
    })
  }

}

