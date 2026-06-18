import { spawn } from 'child_process'
import * as fs from 'fs'
import { execSync } from 'child_process'
import type { BrowserBridgeBrowser } from '@shared/types/browser-bridge'
import { createLogger } from '../../utils/logger'

const log = createLogger('BrowserLauncher')

const MAC_APPS: Record<'chrome' | 'edge' | 'firefox', string[]> = {
  chrome: ['Google Chrome', 'Chromium'],
  edge: ['Microsoft Edge'],
  firefox: ['Firefox'],
}

const EXECUTABLES: Record<'chrome' | 'edge' | 'firefox', string[]> = {
  chrome: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  edge: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/microsoft-edge',
  ],
  firefox: [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    '/usr/bin/firefox',
  ],
}

const LINUX_WHICH: Record<'chrome' | 'edge' | 'firefox', string[]> = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge'],
  firefox: ['firefox'],
}

function resolveExecutable(browser: 'chrome' | 'edge' | 'firefox'): string | null {
  for (const candidate of EXECUTABLES[browser]) {
    if (fs.existsSync(candidate)) return candidate
  }

  if (process.platform !== 'linux') return null

  for (const cmd of LINUX_WHICH[browser]) {
    try {
      const result = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim()
      if (result) return result
    } catch {
      // try next
    }
  }
  return null
}

function openOnMac(appName: string, url: string): void {
  const child = spawn('open', ['-a', appName, url], { detached: true, stdio: 'ignore' })
  child.unref()
  log.info(`Opened ${url} via macOS app ${appName}`)
}

function openFirefoxUrl(executable: string, url: string): void {
  // macOS `open -a` URL-encodes `#` → `%23`，about:debugging#/... 会失效
  const child = spawn(executable, ['-new-tab', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  log.info(`Opened ${url} via Firefox ${executable}`)
}

function openWithExecutable(executable: string, url: string): void {
  const child = spawn(executable, [url], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  log.info(`Opened ${url} via ${executable}`)
}

export function openBrowserInternalUrl(browser: BrowserBridgeBrowser, url: string): void {
  if (browser === 'unknown' || !url) {
    throw new Error('Unsupported browser')
  }

  const target = browser

  if (target === 'firefox') {
    const executable = resolveExecutable('firefox')
    if (!executable) {
      throw new Error('Browser not installed: firefox')
    }
    openFirefoxUrl(executable, url)
    return
  }

  if (process.platform === 'darwin') {
    for (const appName of MAC_APPS[target]) {
      if (fs.existsSync(`/Applications/${appName}.app`)) {
        openOnMac(appName, url)
        return
      }
    }
  }

  const executable = resolveExecutable(target)
  if (!executable) {
    throw new Error(`Browser not installed: ${target}`)
  }

  openWithExecutable(executable, url)
}
