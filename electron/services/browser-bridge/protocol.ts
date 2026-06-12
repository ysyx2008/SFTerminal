import type { BrowserBridgeCommand, BrowserBridgeCommandResult } from '@shared/types/browser-bridge'

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

export function inferBrowserFromOrigin(origin: string): 'chrome' | 'edge' | 'firefox' | 'unknown' {
  if (origin.includes('moz-extension://')) return 'firefox'
  // Edge and Chrome share chrome-extension:// scheme; disambiguate via user-agent not available here
  return 'chrome'
}
