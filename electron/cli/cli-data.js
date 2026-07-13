/* eslint-env node */
/**
 * CLI 数据目录：沙箱隔离 + 借用桌面 AI Profiles / 凭据
 *
 * 默认：CLI 写入 `{desktopUserData}/cli-sandbox/`，不污染桌面历史/日志/关切等。
 * 每次启动从桌面只读复制：
 *   - credentials.json + master.key（各类 Key）
 *   - 配置中的 AI 相关字段（aiProfiles / activeAiProfile / autoVisionModel / aiRules）
 *
 * 环境变量：
 *   SFT_DATA_DIR              显式指定沙箱（测试用临时目录）；未设则用 cli-sandbox
 *   SFT_CLI_SHARE_DESKTOP=1   与桌面共用同一 userData（不做沙箱、不借用）
 *   SFT_CLI_NO_BORROW=1       沙箱内不从桌面复制 Key/Profiles
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const CONFIG_FILE = 'qiyu-terminal-config.json'
const CREDENTIAL_FILES = ['credentials.json', 'master.key']
/** 仅借用跑 AI 所需字段，其它配置留在沙箱默认值，避免污染桌面心智 */
const BORROW_CONFIG_KEYS = ['aiProfiles', 'activeAiProfile', 'autoVisionModel', 'aiRules']

function getDefaultUserDataPath() {
  const appName = 'SailFish'
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName)
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        appName
      )
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        appName
      )
  }
}

function getAppDataPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support')
    case 'win32':
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    default:
      return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  }
}

function getPointerPath() {
  return path.join(getAppDataPath(), 'SailFish', 'data-location.json')
}

/**
 * 桌面端真实 userData（忽略 SFT_DATA_DIR），与 Electron bootstrap / shim 指针逻辑一致。
 */
function resolveDesktopUserData() {
  const defaultPath = getDefaultUserDataPath()
  try {
    const pointerPath = getPointerPath()
    if (fs.existsSync(pointerPath)) {
      const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf-8'))
      if (pointer && typeof pointer.dataDir === 'string' && pointer.dataDir) {
        return pointer.dataDir
      }
    }
  } catch {
    // 指针损坏则回退默认
  }
  return defaultPath
}

function copyFileIfExists(src, dst) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  try {
    fs.chmodSync(dst, 0o600)
  } catch {
    // Windows 等可能不支持 chmod，忽略
  }
  return true
}

/**
 * 把桌面凭据与 AI Profiles 灌进沙箱。可重复调用（每次覆盖借用项）。
 * @returns {{ borrowedCredentials: boolean, borrowedAiProfiles: boolean }}
 */
function borrowDesktopData(desktopDir, sandboxDir) {
  const result = { borrowedCredentials: false, borrowedAiProfiles: false }
  if (!desktopDir || !sandboxDir || path.resolve(desktopDir) === path.resolve(sandboxDir)) {
    return result
  }

  fs.mkdirSync(sandboxDir, { recursive: true })

  for (const name of CREDENTIAL_FILES) {
    if (copyFileIfExists(path.join(desktopDir, name), path.join(sandboxDir, name))) {
      result.borrowedCredentials = true
    }
  }

  const desktopConfigPath = path.join(desktopDir, CONFIG_FILE)
  if (!fs.existsSync(desktopConfigPath)) return result

  let desktopConfig
  try {
    desktopConfig = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
  } catch (err) {
    console.warn('[CLI] 无法读取桌面配置，跳过借用 AI Profiles:', err.message || err)
    return result
  }
  if (!desktopConfig || typeof desktopConfig !== 'object') return result

  const sandboxConfigPath = path.join(sandboxDir, CONFIG_FILE)
  let sandboxConfig = {}
  if (fs.existsSync(sandboxConfigPath)) {
    try {
      sandboxConfig = JSON.parse(fs.readFileSync(sandboxConfigPath, 'utf-8')) || {}
    } catch {
      sandboxConfig = {}
    }
  }
  if (typeof sandboxConfig !== 'object' || Array.isArray(sandboxConfig)) {
    sandboxConfig = {}
  }

  let changed = false
  for (const key of BORROW_CONFIG_KEYS) {
    if (desktopConfig[key] !== undefined) {
      sandboxConfig[key] = desktopConfig[key]
      changed = true
      if (key === 'aiProfiles') result.borrowedAiProfiles = true
    }
  }

  if (changed) {
    fs.writeFileSync(sandboxConfigPath, JSON.stringify(sandboxConfig, null, '\t'), 'utf-8')
  }

  return result
}

/**
 * 在加载 Electron shim / 服务之前调用：设定沙箱路径并借用桌面 Key/Profiles。
 * @returns {{ desktopDir: string, sandboxDir: string, shared: boolean }}
 */
function setupCliDataDir() {
  const desktopDir = resolveDesktopUserData()
  const shareDesktop = process.env.SFT_CLI_SHARE_DESKTOP === '1'

  if (shareDesktop) {
    // 显式与桌面共用：不改 SFT_DATA_DIR，shim 会落到 desktopDir
    return { desktopDir, sandboxDir: desktopDir, shared: true }
  }

  if (!process.env.SFT_DATA_DIR) {
    process.env.SFT_DATA_DIR = path.join(desktopDir, 'cli-sandbox')
  }

  const sandboxDir = process.env.SFT_DATA_DIR
  if (process.env.SFT_CLI_NO_BORROW !== '1') {
    const borrowed = borrowDesktopData(desktopDir, sandboxDir)
    if (borrowed.borrowedAiProfiles || borrowed.borrowedCredentials) {
      const parts = []
      if (borrowed.borrowedAiProfiles) parts.push('AI Profiles')
      if (borrowed.borrowedCredentials) parts.push('credentials')
      console.info(`[CLI] 沙箱: ${sandboxDir}`)
      console.info(`[CLI] 已从桌面借用: ${parts.join(', ')}`)
    } else {
      console.info(`[CLI] 沙箱: ${sandboxDir}（桌面无可借用的 AI/凭据）`)
    }
  }

  return { desktopDir, sandboxDir, shared: false }
}

module.exports = {
  resolveDesktopUserData,
  borrowDesktopData,
  setupCliDataDir,
  BORROW_CONFIG_KEYS,
}
