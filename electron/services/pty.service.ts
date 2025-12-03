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

interface PtyInstance {
  pty: pty.IPty
  dataCallbacks: ((data: string) => void)[]
  disposed: boolean
}

export class PtyService {
  private instances: Map<string, PtyInstance> = new Map()

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
  }
}

