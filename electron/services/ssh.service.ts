import { Client, ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  cols?: number
  rows?: number
}

interface SshInstance {
  client: Client
  stream: ClientChannel | null
  dataCallbacks: ((data: string) => void)[]
  config: SshConfig
}

export class SshService {
  private instances: Map<string, SshInstance> = new Map()

  /**
   * 建立 SSH 连接
   */
  async connect(config: SshConfig): Promise<string> {
    const id = uuidv4()

    return new Promise((resolve, reject) => {
      const client = new Client()

      const instance: SshInstance = {
        client,
        stream: null,
        dataCallbacks: [],
        config
      }

      // 准备私钥
      let privateKey: string | Buffer | undefined = config.privateKey
      if (!privateKey && config.privateKeyPath) {
        try {
          privateKey = fs.readFileSync(config.privateKeyPath)
        } catch (err) {
          reject(new Error(`无法读取私钥文件: ${config.privateKeyPath}`))
          return
        }
      }

      // 连接配置
      const connectConfig: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string | Buffer
        passphrase?: string
        readyTimeout: number
        keepaliveInterval: number
      } = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      }

      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase
        }
      } else if (config.password) {
        connectConfig.password = config.password
      }

      client.on('ready', () => {
        // 打开 Shell
        client.shell(
          {
            term: 'xterm-256color',
            cols: config.cols || 80,
            rows: config.rows || 24
          },
          (err, stream) => {
            if (err) {
              client.end()
              reject(err)
              return
            }

            instance.stream = stream

            // 监听数据
            stream.on('data', (data: Buffer) => {
              const str = data.toString('utf-8')
              instance.dataCallbacks.forEach(callback => callback(str))
            })

            // 监听关闭
            stream.on('close', () => {
              console.log(`SSH ${id} stream closed`)
              client.end()
            })

            this.instances.set(id, instance)
            resolve(id)
          }
        )
      })

      client.on('error', err => {
        console.error(`SSH ${id} error:`, err)
        this.instances.delete(id)
        reject(err)
      })

      client.on('close', () => {
        console.log(`SSH ${id} connection closed`)
        this.instances.delete(id)
      })

      client.connect(connectConfig)
    })
  }

  /**
   * 向 SSH 写入数据
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance?.stream) {
      instance.stream.write(data)
    }
  }

  /**
   * 调整 SSH 终端大小
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance?.stream) {
      instance.stream.setWindow(rows, cols, 0, 0)
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
   * 断开 SSH 连接
   */
  disconnect(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.client.end()
      this.instances.delete(id)
    }
  }

  /**
   * 断开所有 SSH 连接
   */
  disposeAll(): void {
    this.instances.forEach((instance, id) => {
      instance.client.end()
      this.instances.delete(id)
    })
  }

  /**
   * 执行探测命令获取主机信息
   * 通过执行一个组合命令来探测远程主机的操作系统类型
   */
  async probe(id: string, timeout: number = 5000): Promise<string> {
    const instance = this.instances.get(id)
    if (!instance?.stream) {
      throw new Error('SSH connection not found or stream not available')
    }

    return new Promise((resolve) => {
      let output = ''
      let resolved = false
      
      // 生成一个唯一的结束标记
      const endMarker = `__PROBE_END_${Date.now()}__`
      
      // 探测命令：先尝试检测是Windows还是Unix系统
      // Windows 会有 %OS% 变量，Unix 系统会有 uname
      const probeCommand = `echo "---PROBE_START---" && (uname -s 2>/dev/null || echo %OS%) && echo "${endMarker}"\n`
      
      const dataHandler = (data: string) => {
        output += data
        // 检查是否收到结束标记
        if (output.includes(endMarker)) {
          resolved = true
          // 移除这个临时处理器
          const idx = instance.dataCallbacks.indexOf(dataHandler)
          if (idx > -1) {
            instance.dataCallbacks.splice(idx, 1)
          }
          resolve(output)
        }
      }
      
      // 添加临时数据处理器
      instance.dataCallbacks.push(dataHandler)
      
      // 发送探测命令
      instance.stream.write(probeCommand)
      
      // 超时处理
      setTimeout(() => {
        if (!resolved) {
          const idx = instance.dataCallbacks.indexOf(dataHandler)
          if (idx > -1) {
            instance.dataCallbacks.splice(idx, 1)
          }
          resolve(output || 'timeout')
        }
      }, timeout)
    })
  }

  /**
   * 获取 SSH 连接信息
   */
  getConfig(id: string): SshConfig | null {
    const instance = this.instances.get(id)
    return instance?.config || null
  }
}

