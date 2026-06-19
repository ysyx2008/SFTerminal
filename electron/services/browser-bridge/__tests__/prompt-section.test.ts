import { describe, expect, it } from 'vitest'
import { buildBrowserBridgePromptSection } from '../prompt-section'
import type { BrowserBridgeStatus } from '@shared/types/browser-bridge'

function baseStatus(overrides: Partial<BrowserBridgeStatus> = {}): BrowserBridgeStatus {
  return {
    gatewayRunning: true,
    port: 12345,
    connections: [],
    install: null,
    extensionIds: {
      chromium: 'dgmhdapfpihhkboikpgfanpgnijbpdhd',
      chromiumDev: 'ocdljfppijcjpgaaamgeailkgajgjdml',
      firefox: 'sailfish-browser-bridge@yushen.dev',
    },
    ...overrides,
  }
}

describe('buildBrowserBridgePromptSection', () => {
  it('returns empty when components not installed and not connected', () => {
    expect(buildBrowserBridgePromptSection(baseStatus())).toBe('')
  })

  it('includes attach rules when chromium connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        connections: [{ browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' }],
      }),
    )
    expect(section).toContain('# 浏览器助手')
    expect(section).toContain('Chromium')
    expect(section).toContain('已连接')
    expect(section).toContain('无需')
    expect(section).toContain('browser_list_tabs')
    expect(section).not.toContain('两个浏览器都在线')
  })

  it('warns when both browsers connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        connections: [
          { browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' },
          { browser: 'firefox', origin: 'moz-extension://xyz/', state: 'ready' },
        ],
      }),
    )
    expect(section).toContain('两个浏览器都在线')
  })

  it('shows install hint when components installed but not connected', () => {
    const section = buildBrowserBridgePromptSection(
      baseStatus({
        install: {
          chromiumExtensionPath: '/tmp/ext',
          firefoxExtensionPath: '/tmp/ff',
          nativeHostPath: '/tmp/host.json',
          registeredBrowsers: ['chrome'],
          errors: [],
        },
      }),
    )
    expect(section).toContain('扩展未连接')
    expect(section).toContain('browser_launch')
  })
})
