import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import {
  BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID,
  BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
  type BrowserBridgeAttachTarget,
  type BrowserBridgeBrowser,
  type BrowserBridgeCommandResult,
  type BrowserBridgeInstallStatus,
  type BrowserBridgeStatus,
} from '@shared/types/browser-bridge'
import { createLogger } from '../../utils/logger'
import { getBridgeRoot, getExtensionGuideUrls, installBrowserBridge, detectInstallStatus, uninstallBrowserBridge, writeBridgePointer } from './installer'
import { openBrowserInternalUrl } from './browser-launcher'
import {
  inferBrowserFromOrigin,
  isChromiumOrigin,
  isCommandResult,
  isFirefoxHostOrigin,
  normalizeAttachTargetInput,
  parseGatewayLines,
  serializeGatewayLine,
} from './protocol'

const log = createLogger('BrowserBridgeService')

interface HostConnection {
  origin: string
  browser: BrowserBridgeBrowser
  socket: net.Socket
  buffer: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class BrowserBridgeService {
  private server: net.Server | null = null
  private port: number | null = null
  private token = ''
  private hosts = new Map<net.Socket, HostConnection>()
  private pending = new Map<string, PendingRequest>()
  private lastInstall: BrowserBridgeInstallStatus | null = null
  private started = false

  async start(): Promise<void> {
    if (this.started) return
    this.token = crypto.randomBytes(16).toString('hex')
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket))
      this.server.on('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to bind browser bridge gateway'))
          return
        }
        this.port = address.port
        this.persistGateway()
        this.started = true
        log.info(`Gateway listening on 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const { socket } of this.hosts.values()) {
      socket.destroy()
    }
    this.hosts.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Browser bridge stopped'))
    }
    this.pending.clear()
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => resolve())
    })
    this.server = null
    this.started = false
    this.port = null
  }

  private persistGateway(): void {
    const root = getBridgeRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'gateway.json'),
      `${JSON.stringify({ port: this.port, token: this.token, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    )
    try {
      writeBridgePointer()
    } catch (error) {
      log.warn('Failed to update bridge pointer:', error)
    }
  }

  install(): BrowserBridgeInstallStatus {
    if (!this.started) {
      throw new Error('Browser bridge gateway is not running')
    }
    this.persistGateway()
    this.lastInstall = installBrowserBridge()
    if (this.lastInstall.errors.length) {
      log.warn('Browser bridge install completed with errors:', this.lastInstall.errors)
    } else {
      log.info('Browser bridge installed')
    }
    return this.lastInstall
  }

  uninstall(): { errors: string[] } {
    const result = uninstallBrowserBridge()
    this.lastInstall = null
    if (result.errors.length) {
      log.warn('Browser bridge uninstall completed with errors:', result.errors)
    } else {
      log.info('Browser bridge uninstalled')
    }
    return result
  }

  getStatus(): BrowserBridgeStatus {
    const detected = detectInstallStatus()
    if (detected) this.lastInstall = detected
    const install = this.lastInstall
    const connections = [...this.hosts.values()].map((host) => ({
      browser: host.browser,
      origin: host.origin,
      state: 'ready' as const,
    }))
    return {
      gatewayRunning: this.started,
      port: this.port,
      connections,
      install,
      extensionIds: {
        chromium: BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID,
        firefox: BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
      },
    }
  }

  async openExtensionGuide(browser: BrowserBridgeBrowser): Promise<void> {
    const urls = getExtensionGuideUrls()
    const url = urls[browser]
    if (!url) throw new Error(`Unsupported browser: ${browser}`)
    openBrowserInternalUrl(browser, url)
  }

  resolveConnection(browserInput: unknown = 'auto'): {
    origin: string
    browserTarget: BrowserBridgeAttachTarget
  } {
    const requested = normalizeAttachTargetInput(browserInput)
    const all = [...this.hosts.values()]
    const firefoxHosts = all.filter((h) => isFirefoxHostOrigin(h.origin))
    const chromiumHosts = all.filter((h) => isChromiumOrigin(h.origin))

    if (!firefoxHosts.length && !chromiumHosts.length) {
      throw new Error(
        '浏览器扩展未连接。请在 SailFish 设置 → 浏览器助手中安装组件，并在 Chrome/Edge/Firefox 中加载扩展。',
      )
    }

    if (requested === 'auto') {
      if (firefoxHosts.length && chromiumHosts.length) {
        throw new Error(
          'Chromium 与 Firefox 均已连接。请在 browser_launch 中指定 browser: "firefox" 或 "chromium"（用户说火狐/Firefox 用 firefox，Chrome/谷歌浏览器用 chromium）。',
        )
      }
      if (firefoxHosts.length) {
        return { origin: firefoxHosts[0].origin, browserTarget: 'firefox' }
      }
      return { origin: chromiumHosts[0].origin, browserTarget: 'chromium' }
    }

    if (requested === 'firefox') {
      if (!firefoxHosts.length) {
        throw new Error('Firefox 扩展未连接。请在 Firefox about:debugging 中加载 SailFish 浏览器助手扩展。')
      }
      return { origin: firefoxHosts[0].origin, browserTarget: 'firefox' }
    }

    if (!chromiumHosts.length) {
      throw new Error(
        'Chromium 浏览器扩展未连接。请在 Chrome/Edge 等 Chromium 浏览器的扩展页加载 SailFish 浏览器助手。',
      )
    }
    if (chromiumHosts.length > 1) {
      log.warn(`Multiple Chromium connections (${chromiumHosts.length}); using first`)
    }
    return { origin: chromiumHosts[0].origin, browserTarget: 'chromium' }
  }

  async sendCommand(
    action: string,
    payload: Record<string, unknown> = {},
    options: { origin?: string; target?: BrowserBridgeAttachTarget; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const host = this.pickHost(options)
    if (!host) {
      throw new Error(
        'Browser extension not connected. Enable Browser Assistant in SailFish Settings and load the extension in Chrome/Edge/Firefox.',
      )
    }

    const id = `sf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const timeoutMs = options.timeoutMs ?? 60000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser bridge timeout: ${action}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      })

      host.socket.write(
        serializeGatewayLine({
          type: 'extension_message',
          origin: host.origin,
          message: { id, action, payload },
        }),
      )
    })
  }

  private pickHost(options: {
    origin?: string
    target?: BrowserBridgeAttachTarget
  } = {}): HostConnection | undefined {
    const all = [...this.hosts.values()]
    if (!all.length) return undefined
    if (options.origin) {
      const match = all.find((h) => h.origin === options.origin)
      if (match) return match
    }
    if (options.target === 'firefox') {
      return all.find((h) => isFirefoxHostOrigin(h.origin))
    }
    if (options.target === 'chromium') {
      return all.find((h) => isChromiumOrigin(h.origin))
    }
    return all[0]
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const parsed = parseGatewayLines(buffer)
      buffer = parsed.rest
      for (const message of parsed.messages) {
        this.handleGatewayMessage(socket, message)
      }
    })
    socket.on('close', () => {
      const host = this.hosts.get(socket)
      if (host) this.hosts.delete(socket)
    })
    socket.on('error', (error) => {
      log.warn('Host socket error:', error.message)
    })
  }

  private handleGatewayMessage(socket: net.Socket, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>

    if (message.type === 'host_register') {
      if (message.token !== this.token) {
        socket.destroy()
        return
      }
      const origin = String(message.origin || 'unknown')
      this.hosts.set(socket, {
        origin,
        browser: inferBrowserFromOrigin(origin),
        socket,
        buffer: '',
      })
      log.info(`Host registered: ${origin}`)
      return
    }

    if (message.type === 'extension_message') {
      const inner = message.message
      if (isCommandResult(inner)) {
        this.resolvePending(inner)
      }
    }
  }

  private resolvePending(result: BrowserBridgeCommandResult): void {
    const pending = this.pending.get(result.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(result.id)
    if (result.success) pending.resolve(result.data)
    else pending.reject(new Error(result.error || 'Browser bridge command failed'))
  }
}

let instance: BrowserBridgeService | null = null

export function getBrowserBridgeService(): BrowserBridgeService {
  if (!instance) instance = new BrowserBridgeService()
  return instance
}

export async function initBrowserBridgeService(): Promise<BrowserBridgeService> {
  const service = getBrowserBridgeService()
  await service.start()
  try {
    service.install()
  } catch (error) {
    log.warn('Initial browser bridge install failed:', error)
  }
  return service
}
