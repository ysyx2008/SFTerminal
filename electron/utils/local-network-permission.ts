/**
 * macOS 本地网络（Local Network）权限触发
 *
 * ⚠️ 勿随意删除或「精简」本文件及启动/SSH 失败时的调用点。
 * 实测：构建版主机管理连局域网/VM 会出现静默 EHOSTUNREACH（系统 ssh 仍通），
 * 根因是 macOS TCC；本探测 + Info.plist 的 NSLocalNetworkUsageDescription /
 * NSBonjourServices 是修复路径。删掉后问题会复发且难排查。
 *
 * macOS 15+ 对局域网出站做 TCC 管控。仅有 NSLocalNetworkUsageDescription
 * 不够——若从未触发过 Bonjour/mDNS 类操作，应用可能不出现在
 * 「系统设置 → 隐私与安全性 → 本地网络」，且 TCP 连接会静默得到 EHOSTUNREACH。
 * （系统设置里也没有手动「+」添加应用的入口。）
 *
 * 向 mDNS 组播地址发 1 字节 UDP，是 Electron 生态常用的触发方式。
 */
import * as dgram from 'dgram'
import { createLogger } from './logger'

const log = createLogger('LocalNetworkPermission')

/** mDNS / Bonjour 组播（IANA） */
const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const SOCKET_TIMEOUT_MS = 5_000

let lastRequestAt = 0
const MIN_INTERVAL_MS = 60_000

/**
 * 触发 macOS 本地网络授权弹窗（幂等、失败静默）。
 * 非 darwin 直接 no-op。
 */
export function requestLocalNetworkAccess(reason = 'startup'): void {
  if (process.platform !== 'darwin') return

  const now = Date.now()
  if (now - lastRequestAt < MIN_INTERVAL_MS) {
    log.debug(`skip Local Network probe (throttled, reason=${reason})`)
    return
  }
  lastRequestAt = now

  try {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let closed = false
    const closeSocket = () => {
      if (closed) return
      closed = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }

    socket.on('error', (err) => {
      log.debug(`Local Network probe socket error (${reason}):`, err.message)
      closeSocket()
    })

    const timer = setTimeout(closeSocket, SOCKET_TIMEOUT_MS)
    socket.send(Buffer.from([0]), MDNS_PORT, MDNS_ADDR, (err) => {
      clearTimeout(timer)
      if (err) {
        log.debug(`Local Network probe send failed (${reason}):`, err.message)
      } else {
        log.info(`Local Network permission probe sent (${reason})`)
      }
      closeSocket()
    })
  } catch (err) {
    log.debug(`Local Network probe failed (${reason}):`, err)
  }
}

/**
 * 是否像 macOS 本地网络 TCC 拒绝（系统常见 errno 为 EHOSTUNREACH）。
 * 不含 ENETUNREACH / no route，避免把真·路由故障误导成权限问题。
 */
export function isLikelyMacLocalNetworkDenied(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message
  const lower = message.toLowerCase()
  return lower.includes('ehostunreach') || /\bhost unreachable\b/.test(lower)
}

/** SSH/SFTP 连接失败时：若像本地网络 TCC 拒绝，再触发一次授权探测 */
export function requestLocalNetworkAccessIfDenied(error: Error | string, reason: string): void {
  if (process.platform === 'darwin' && isLikelyMacLocalNetworkDenied(error)) {
    requestLocalNetworkAccess(reason)
  }
}
