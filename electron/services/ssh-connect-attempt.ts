import type { Client } from 'ssh2'

/** 用户主动放弃连接时抛出，调用方据此区别于真正的连接失败 */
export class SshConnectCancelledError extends Error {
  constructor(message = 'SSH connect cancelled by user') {
    super(message)
    this.name = 'SshConnectCancelledError'
  }
}

function destroyClient(client: Client): void {
  try {
    client.end()
  } catch {
    /* 握手中断开可能抛错，忽略 */
  }
  try {
    client.destroy()
  } catch {
    /* 同上 */
  }
}

/**
 * 一次 SSH 连接尝试的可中止句柄。
 *
 * 握手期间的 ssh2 客户端（跳板机级联时有多个）登记进来，取消时统一销毁，
 * 并让挂起的连接 Promise 立刻以 SshConnectCancelledError 结束——不等 readyTimeout。
 */
export class SshConnectAttempt {
  private readonly clients = new Set<Client>()
  private readonly cancelHandlers = new Set<() => void>()
  private cancelled = false

  get isCancelled(): boolean {
    return this.cancelled
  }

  /** 登记握手期客户端；若已取消则立即销毁，避免"取消后才创建"的竞态漏网 */
  trackClient(client: Client): void {
    if (this.cancelled) {
      destroyClient(client)
      return
    }
    this.clients.add(client)
  }

  /** 注册取消收尾（用于 reject 挂起的连接 Promise）；已取消则立刻执行 */
  onCancel(handler: () => void): void {
    if (this.cancelled) {
      handler()
      return
    }
    this.cancelHandlers.add(handler)
  }

  /**
   * 中止本次尝试。
   * 先跑收尾（让 Promise 以「已取消」结束），再销毁客户端——
   * 否则销毁触发的 socket error 会先把 Promise 变成一条网络错误。
   */
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true

    const handlers = [...this.cancelHandlers]
    this.cancelHandlers.clear()
    for (const handler of handlers) {
      try {
        handler()
      } catch {
        /* 收尾失败不影响后续销毁 */
      }
    }

    for (const client of this.clients) {
      destroyClient(client)
    }
    this.clients.clear()
  }
}
