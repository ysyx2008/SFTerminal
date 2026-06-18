import type {
  BrowserBridgeAttachTarget,
  BrowserBridgeCommand,
  BrowserBridgeCommandResult,
  BrowserBridgePingResult,
} from '@shared/types/browser-bridge'
import { BROWSER_BRIDGE_PROTOCOL_VERSION } from '@shared/types/browser-bridge'

export function parseGatewayLines(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let rest = buffer
  let idx = rest.indexOf('\n')
  while (idx >= 0) {
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    if (line) {
      try {
        messages.push(JSON.parse(line))
      } catch {
        // skip malformed
      }
    }
    idx = rest.indexOf('\n')
  }
  return { messages, rest }
}

export function serializeGatewayLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

export function isCommandResult(value: unknown): value is BrowserBridgeCommandResult {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.id === 'string' && typeof obj.success === 'boolean'
}

export function isCommand(value: unknown): value is BrowserBridgeCommand {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.id === 'string' && typeof obj.action === 'string'
}

export function isLegacyFirefoxManifestOrigin(origin: string): boolean {
  return origin.endsWith('.json') && /Mozilla\/NativeMessagingHosts/i.test(origin)
}

export function isFirefoxHostOrigin(origin: string): boolean {
  return isFirefoxOrigin(origin) || isLegacyFirefoxManifestOrigin(origin)
}

export function inferBrowserFromOrigin(origin: string): 'chrome' | 'edge' | 'firefox' | 'unknown' {
  if (isFirefoxHostOrigin(origin)) return 'firefox'
  if (origin.includes('chrome-extension://')) return 'chrome'
  return 'unknown'
}

export function isFirefoxOrigin(origin: string): boolean {
  return origin.startsWith('moz-extension://')
}

export function isChromiumOrigin(origin: string): boolean {
  return origin.startsWith('chrome-extension://')
}

export function normalizeAttachTargetInput(input: unknown): BrowserBridgeAttachTarget | 'auto' {
  if (input === undefined || input === null || input === '') return 'auto'
  const value = String(input).toLowerCase()
  if (value === 'auto') return 'auto'
  if (value === 'firefox' || value === 'ff') return 'firefox'
  if (value === 'chromium' || value === 'chrome' || value === 'edge') return 'chromium'
  return 'auto'
}

export function attachTargetLabel(target: BrowserBridgeAttachTarget): string {
  return target === 'firefox' ? 'Firefox' : 'Chromium（Chrome/Edge 等）'
}

export function attachTargetFromOrigin(origin: string): BrowserBridgeAttachTarget | null {
  if (isFirefoxOrigin(origin)) return 'firefox'
  if (isChromiumOrigin(origin)) return 'chromium'
  return null
}

export function parsePingResult(value: unknown): BrowserBridgePingResult | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj.extension !== 'string' || typeof obj.version !== 'string') return null
  const protocol = typeof obj.protocol === 'number' ? obj.protocol : undefined
  return { extension: obj.extension, version: obj.version, protocol }
}

/** protocol v1：扩展只传 HTML 原语，正文提取在桌面端 */
export function supportsProtocolV1(ping: BrowserBridgePingResult | null | undefined): boolean {
  if (!ping) return false
  return (ping.protocol ?? 0) >= BROWSER_BRIDGE_PROTOCOL_VERSION
}

