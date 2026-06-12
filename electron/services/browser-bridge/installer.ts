import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID,
  BROWSER_BRIDGE_FIREFOX_EXTENSION_ID,
  BROWSER_BRIDGE_NATIVE_HOST,
  type BrowserBridgeBrowser,
  type BrowserBridgeInstallStatus,
} from '@shared/types/browser-bridge'
import { createLogger } from '../../utils/logger'

const log = createLogger('BrowserBridgeInstaller')

/** Native Host 进程无法访问 Electron，通过 $HOME 下指针文件定位当前 userData（可自定义数据目录） */
export const BRIDGE_POINTER_BASENAME = '.sailfish-browser-bridge.json'

export function getBridgeRoot(): string {
  return path.join(app.getPath('userData'), 'browser-bridge')
}

export function getBridgePointerPath(): string {
  return path.join(app.getPath('home'), BRIDGE_POINTER_BASENAME)
}

export function writeBridgePointer(): void {
  const root = getBridgeRoot()
  writeJson(getBridgePointerPath(), {
    bridgeRoot: root,
    gatewayFile: path.join(root, 'gateway.json'),
    userData: app.getPath('userData'),
    updatedAt: Date.now(),
  })
}

export function removeBridgePointer(): void {
  const pointerPath = getBridgePointerPath()
  if (!fs.existsSync(pointerPath)) return
  try {
    fs.unlinkSync(pointerPath)
  } catch (error) {
    log.warn('Failed to remove bridge pointer:', error)
  }
}

export function getBundledBridgeRoot(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-bridge')
    : path.join(app.getAppPath(), 'resources', 'browser-bridge')
  return base
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function chmodExecutable(filePath: string): void {
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(filePath, 0o755)
  } catch {
    // ignore
  }
}

function hostLauncherPath(hostDir: string): string {
  if (process.platform === 'win32') return path.join(hostDir, 'host.cmd')
  return path.join(hostDir, 'host.sh')
}

const MAC_NATIVE_HOST_HELPER_NAME = 'sailfish-browser-host'

function buildChromiumNativeHostManifest(hostPath: string, extensionId: string): Record<string, unknown> {
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST,
    description: 'SailFish Browser Assistant Native Host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
}

/** Firefox 使用 allowed_extensions（扩展 ID 字符串），不是 allowed_origins */
function buildFirefoxNativeHostManifest(hostPath: string, extensionId: string): Record<string, unknown> {
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST,
    description: 'SailFish Browser Assistant Native Host',
    path: hostPath,
    type: 'stdio',
    allowed_extensions: [extensionId],
  }
}

/** macOS：App 包 Contents/Helpers/ 下的 Mach-O（Claude / 智谱同款路径，Chrome 才能拉起） */
function getMacAppBundleHelperPath(): string {
  const execDir = path.dirname(process.execPath)
  return path.join(execDir, '..', 'Helpers', MAC_NATIVE_HOST_HELPER_NAME)
}

/** macOS：编译 Mach-O 启动器；失败则回退 $HOME wrapper */
function buildMacNativeHostBinary(hostDir: string, hostShPath: string, binaryPath: string): boolean {
  const bundledC = path.join(getBundledBridgeRoot(), 'native-host', 'host-launcher.c')
  if (!fs.existsSync(bundledC)) return false

  const copiedC = path.join(hostDir, 'host-launcher.c')
  fs.copyFileSync(bundledC, copiedC)
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })

  try {
    execFileSync(
      'clang',
      ['-o', binaryPath, copiedC, `-DHOST_SH_PATH=${JSON.stringify(hostShPath)}`],
      { stdio: 'pipe' },
    )
    chmodExecutable(binaryPath)
    try {
      execFileSync('xattr', ['-cr', binaryPath], { stdio: 'ignore' })
      execFileSync('codesign', ['-s', '-', '--force', binaryPath], { stdio: 'ignore' })
    } catch {
      // ignore
    }
    return true
  } catch (error) {
    log.warn('Failed to compile native host binary (is Xcode CLT installed?):', error)
    return false
  }
}

function resolveManifestHostPath(hostDir: string): string {
  const launcher = hostLauncherPath(hostDir)
  if (process.platform !== 'darwin') return launcher

  removeLegacyNativeHostAliases()

  const helperPath = path.resolve(getMacAppBundleHelperPath())
  if (buildMacNativeHostBinary(hostDir, launcher, helperPath)) {
    log.info(`Native host binary: ${helperPath} -> ${launcher}`)
    return helperPath
  }

  const aliasPath = path.join(app.getPath('home'), '.sailfish-browser-host')
  const wrapper = `#!/bin/bash\nexec "${launcher}" "$@"\n`
  try {
    fs.writeFileSync(aliasPath, wrapper, 'utf8')
    chmodExecutable(aliasPath)
    try {
      execFileSync('xattr', ['-cr', aliasPath], { stdio: 'ignore' })
      execFileSync('xattr', ['-cr', hostDir], { stdio: 'ignore' })
    } catch {
      // ignore
    }
    log.warn(`Native host fallback wrapper: ${aliasPath} -> ${launcher}`)
    return aliasPath
  } catch (error) {
    log.warn('Failed to create native host wrapper, using direct launcher path:', error)
    return launcher
  }
}

function removeLegacyNativeHostAliases(): void {
  if (process.platform !== 'darwin') return
  const homeAlias = path.join(app.getPath('home'), '.sailfish-browser-host')
  if (fs.existsSync(homeAlias)) {
    try {
      fs.unlinkSync(homeAlias)
    } catch {
      // ignore
    }
  }
}

function removeNativeHostHelper(): void {
  if (process.platform !== 'darwin') return
  removeLegacyNativeHostAliases()
  const helperPath = path.resolve(getMacAppBundleHelperPath())
  if (!fs.existsSync(helperPath)) return
  try {
    fs.unlinkSync(helperPath)
  } catch (error) {
    log.warn('Failed to remove native host helper:', error)
  }
}

function registerWindowsNativeHost(manifestPath: string, browsers: BrowserBridgeBrowser[]): void {
  for (const key of nativeHostRegistryTargets(browsers)) {
    try {
      execFileSync('reg', ['add', `HKCU\\${key}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      log.warn(`Failed to register ${key}:`, error)
      throw error
    }
  }
}

function writeNativeHostManifestFile(manifest: Record<string, unknown>, dir: string): void {
  const manifestName = nativeHostManifestName()
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, manifestName)
  writeJson(dest, manifest)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o644)
  log.info(`Registered native host: ${dest}`)
}

function registerMacNativeHost(
  chromiumManifest: Record<string, unknown>,
  firefoxManifest: Record<string, unknown>,
  browsers: BrowserBridgeBrowser[],
): void {
  if (browsers.includes('chrome') || browsers.includes('edge')) {
    for (const dir of getChromiumNativeHostDirs()) {
      try {
        writeNativeHostManifestFile(chromiumManifest, dir)
      } catch (error) {
        log.warn(`Failed to register native host at ${dir}:`, error)
      }
    }
  }
  if (browsers.includes('firefox')) {
    for (const dir of getFirefoxNativeHostDirs()) {
      try {
        writeNativeHostManifestFile(firefoxManifest, dir)
      } catch (error) {
        log.warn(`Failed to register native host at ${dir}:`, error)
      }
    }
  }
}

function registerLinuxNativeHost(
  chromiumManifest: Record<string, unknown>,
  firefoxManifest: Record<string, unknown>,
  browsers: BrowserBridgeBrowser[],
): void {
  registerMacNativeHost(chromiumManifest, firefoxManifest, browsers)
}

function writeHostEnvScripts(hostDir: string, electronExe: string, gatewayFile: string): void {
  const envContent = [
    `SAILFISH_ELECTRON_EXE=${electronExe}`,
    `SAILFISH_BROWSER_BRIDGE_GATEWAY=${gatewayFile}`,
    '',
  ].join('\n')
  writeJson(path.join(hostDir, 'host-env.json'), {
    SAILFISH_ELECTRON_EXE: electronExe,
    SAILFISH_BROWSER_BRIDGE_GATEWAY: gatewayFile,
  })

  if (process.platform === 'win32') {
    const cmdPath = path.join(hostDir, 'host.cmd')
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\nset "SAILFISH_ELECTRON_EXE=${electronExe}"\r\nset "SAILFISH_BROWSER_BRIDGE_GATEWAY=${gatewayFile}"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electronExe}" "${path.join(hostDir, 'host.mjs')}" %*\r\n`,
      'utf8',
    )
  } else {
    const shPath = path.join(hostDir, 'host.sh')
    fs.writeFileSync(
      shPath,
      `#!/bin/bash\nexport SAILFISH_ELECTRON_EXE="${electronExe}"\nexport SAILFISH_BROWSER_BRIDGE_GATEWAY="${gatewayFile}"\nexport ELECTRON_RUN_AS_NODE=1\nexec "${electronExe}" "${path.join(hostDir, 'host.mjs')}" "$@"\n`,
      'utf8',
    )
    chmodExecutable(shPath)
  }

  fs.writeFileSync(path.join(hostDir, 'host-env.txt'), envContent, 'utf8')
}

function nativeHostManifestName(): string {
  return `${BROWSER_BRIDGE_NATIVE_HOST}.json`
}

function nativeHostRegistryTargets(browsers: BrowserBridgeBrowser[]): string[] {
  const keySuffix = `Software\\${'%BROWSER%'}\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST}`
  const targets: string[] = []
  if (browsers.includes('chrome')) targets.push(keySuffix.replace('%BROWSER%', 'Google\\Chrome'))
  if (browsers.includes('edge')) targets.push(keySuffix.replace('%BROWSER%', 'Microsoft\\Edge'))
  if (browsers.includes('firefox')) targets.push(keySuffix.replace('%BROWSER%', 'Mozilla\\Firefox'))
  return targets
}

function getChromiumNativeHostDirs(): string[] {
  const home = app.getPath('home')
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')

  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library/Application Support')
    return [
      path.join(base, 'Google/Chrome/NativeMessagingHosts'),
      path.join(base, 'Google/Chrome Canary/NativeMessagingHosts'),
      path.join(base, 'Google/Chrome Beta/NativeMessagingHosts'),
      path.join(base, 'Chromium/NativeMessagingHosts'),
      path.join(base, 'Arc/User Data/NativeMessagingHosts'),
      path.join(base, 'BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(base, 'Microsoft Edge/NativeMessagingHosts'),
      path.join(base, 'Vivaldi/NativeMessagingHosts'),
      path.join(base, 'com.operasoftware.Opera/NativeMessagingHosts'),
    ]
  }

  if (process.platform === 'linux') {
    return [
      path.join(configHome, 'google-chrome/NativeMessagingHosts'),
      path.join(configHome, 'google-chrome-beta/NativeMessagingHosts'),
      path.join(configHome, 'chromium/NativeMessagingHosts'),
      path.join(configHome, 'BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(configHome, 'microsoft-edge/NativeMessagingHosts'),
      path.join(configHome, 'vivaldi/NativeMessagingHosts'),
    ]
  }

  return []
}

function getFirefoxNativeHostDirs(): string[] {
  const home = app.getPath('home')
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')

  if (process.platform === 'darwin') {
    return [path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
  }
  if (process.platform === 'linux') {
    return [path.join(configHome, 'mozilla/native-messaging-hosts')]
  }
  return []
}

function getAllNativeHostManifestDirs(browsers: BrowserBridgeBrowser[]): string[] {
  const dirs: string[] = []
  if (browsers.includes('chrome') || browsers.includes('edge')) {
    dirs.push(...getChromiumNativeHostDirs())
  }
  if (browsers.includes('firefox')) {
    dirs.push(...getFirefoxNativeHostDirs())
  }
  return [...new Set(dirs)]
}

function nativeHostManifestDirs(browsers: BrowserBridgeBrowser[]): Array<{ browser: BrowserBridgeBrowser; dir: string }> {
  return getAllNativeHostManifestDirs(browsers).map((dir) => ({ browser: 'chrome' as BrowserBridgeBrowser, dir }))
}

function isWindowsNativeHostRegistered(browser: BrowserBridgeBrowser): boolean {
  if (process.platform !== 'win32' || browser === 'unknown') return false
  const key = nativeHostRegistryTargets([browser])[0]
  if (!key) return false
  try {
    execFileSync('reg', ['query', `HKCU\\${key}`], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function detectRegisteredBrowsers(_expectedManifestPath: string): BrowserBridgeBrowser[] {
  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']
  const registered: BrowserBridgeBrowser[] = []
  const manifestName = nativeHostManifestName()

  if (process.platform === 'win32') {
    for (const browser of browsers) {
      if (isWindowsNativeHostRegistered(browser)) registered.push(browser)
    }
    return registered
  }

  for (const { browser, dir } of nativeHostManifestDirs(browsers)) {
    if (fs.existsSync(path.join(dir, manifestName))) registered.push(browser)
  }
  return registered
}

export function detectInstallStatus(): BrowserBridgeInstallStatus | null {
  const root = getBridgeRoot()
  const chromiumDest = path.join(root, 'extension-chromium')
  const firefoxDest = path.join(root, 'extension-firefox')
  const hostDest = path.join(root, 'native-host')
  const manifestPath = path.join(hostDest, nativeHostManifestName())

  const hasChromium = fs.existsSync(path.join(chromiumDest, 'manifest.json'))
  const hasHost = fs.existsSync(manifestPath)
  if (!hasChromium || !hasHost) return null

  const registeredBrowsers = detectRegisteredBrowsers(manifestPath)
  return {
    chromiumExtensionPath: chromiumDest,
    firefoxExtensionPath: firefoxDest,
    nativeHostManifestPath: manifestPath,
    registeredBrowsers,
    errors: [],
  }
}

function unregisterWindowsNativeHost(browsers: BrowserBridgeBrowser[]): void {
  for (const key of nativeHostRegistryTargets(browsers)) {
    try {
      execFileSync('reg', ['delete', `HKCU\\${key}`, '/f'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // key may not exist
    }
  }
}

function unregisterMacLinuxNativeHost(browsers: BrowserBridgeBrowser[]): void {
  const manifestName = nativeHostManifestName()
  for (const dir of getAllNativeHostManifestDirs(browsers)) {
    const filePath = path.join(dir, manifestName)
    if (!fs.existsSync(filePath)) continue
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      log.warn(`Failed to remove native host manifest ${filePath}:`, error)
    }
  }
}

export function uninstallBrowserBridge(): { errors: string[] } {
  const errors: string[] = []
  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']

  try {
    if (process.platform === 'win32') unregisterWindowsNativeHost(browsers)
    else unregisterMacLinuxNativeHost(browsers)
    removeNativeHostHelper()
    removeBridgePointer()
  } catch (error) {
    errors.push(`Native host unregister failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const root = getBridgeRoot()
  for (const sub of ['extension-chromium', 'extension-firefox', 'native-host']) {
    const target = path.join(root, sub)
    if (!fs.existsSync(target)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch (error) {
      errors.push(`Remove ${sub} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { errors }
}

export function installBrowserBridge(): BrowserBridgeInstallStatus {
  const bundled = getBundledBridgeRoot()
  const root = getBridgeRoot()
  const errors: string[] = []
  const registeredBrowsers: BrowserBridgeBrowser[] = []

  const chromiumSrc = path.join(bundled, 'chromium')
  const firefoxSrc = path.join(bundled, 'firefox')
  const hostSrc = path.join(bundled, 'native-host')
  const chromiumDest = path.join(root, 'extension-chromium')
  const firefoxDest = path.join(root, 'extension-firefox')
  const hostDest = path.join(root, 'native-host')

  try {
    if (fs.existsSync(chromiumSrc)) copyDir(chromiumSrc, chromiumDest)
    if (fs.existsSync(firefoxSrc)) copyDir(firefoxSrc, firefoxDest)
    if (fs.existsSync(hostSrc)) copyDir(hostSrc, hostDest)
  } catch (error) {
    errors.push(`Copy failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const electronExe = process.execPath
  const gatewayFile = path.join(root, 'gateway.json')
  writeHostEnvScripts(hostDest, electronExe, gatewayFile)

  const manifestPath = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}.json`)
  const hostPath = resolveManifestHostPath(hostDest)
  const chromiumManifest = buildChromiumNativeHostManifest(hostPath, BROWSER_BRIDGE_CHROMIUM_EXTENSION_ID)
  const firefoxManifest = buildFirefoxNativeHostManifest(hostPath, BROWSER_BRIDGE_FIREFOX_EXTENSION_ID)
  // 供 detectInstallStatus 读取的副本（Chrome 版）
  writeJson(manifestPath, { ...chromiumManifest, path: hostPath })

  const browsers: BrowserBridgeBrowser[] = ['chrome', 'edge', 'firefox']
  try {
    if (process.platform === 'win32') {
      const winChromium = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}-chrome.json`)
      const winFirefox = path.join(hostDest, `${BROWSER_BRIDGE_NATIVE_HOST}-firefox.json`)
      writeJson(winChromium, { ...chromiumManifest, path: hostPath })
      writeJson(winFirefox, { ...firefoxManifest, path: hostPath })
      registerWindowsNativeHost(winChromium, ['chrome', 'edge'])
      registerWindowsNativeHost(winFirefox, ['firefox'])
    } else if (process.platform === 'darwin') {
      registerMacNativeHost(chromiumManifest, firefoxManifest, browsers)
    } else {
      registerLinuxNativeHost(chromiumManifest, firefoxManifest, browsers)
    }
    registeredBrowsers.push(...browsers)
  } catch (error) {
    errors.push(`Native host registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    writeBridgePointer()
  } catch (error) {
    errors.push(`Bridge pointer write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    chromiumExtensionPath: chromiumDest,
    firefoxExtensionPath: firefoxDest,
    nativeHostManifestPath: manifestPath,
    registeredBrowsers,
    errors,
  }
}

export function getExtensionGuideUrls(): Record<BrowserBridgeBrowser, string> {
  return {
    chrome: 'chrome://extensions',
    edge: 'edge://extensions',
    firefox: 'about:debugging#/runtime/this-firefox',
    unknown: '',
  }
}
