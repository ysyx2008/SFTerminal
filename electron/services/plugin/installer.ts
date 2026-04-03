/**
 * 插件安装器
 * 
 * 通过 npm install 安装/卸载/更新插件包。
 * 安装目标目录为 {userData}/plugins/，使用 --prefix 隔离。
 */

import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { loadManifest } from './loader'
import { createLogger } from '../../utils/logger'

const log = createLogger('PluginInstaller')

export interface InstallResult {
  success: boolean
  pluginId?: string
  error?: string
}

/**
 * 获取插件安装根目录
 */
function getPluginsDir(userDataPath: string): string {
  const dir = path.join(userDataPath, 'plugins')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 确保 package.json 存在（npm install --prefix 需要）
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'sailfish-plugins', private: true }, null, 2))
  }
  return dir
}

/**
 * 安装插件
 * @param spec npm 包名/路径/tarball（如 "@openclaw/voice-call", "./my-plugin", "./my-plugin.tgz"）
 */
export async function installPlugin(spec: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Installing plugin: ${spec}`)

  try {
    await npmExec(['install', '--save', spec], pluginsDir)

    // 查找新安装的插件 manifest
    const nodeModules = path.join(pluginsDir, 'node_modules')
    const pluginId = findInstalledPluginId(nodeModules, spec)
    if (pluginId) {
      log.info(`Plugin installed: ${pluginId}`)
      return { success: true, pluginId }
    }

    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to install plugin "${spec}":`, err)
    return { success: false, error: errorMsg }
  }
}

/**
 * 卸载插件
 */
export async function uninstallPlugin(packageName: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Uninstalling plugin: ${packageName}`)

  try {
    await npmExec(['uninstall', packageName], pluginsDir)
    log.info(`Plugin uninstalled: ${packageName}`)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to uninstall plugin "${packageName}":`, err)
    return { success: false, error: errorMsg }
  }
}

/**
 * 更新插件
 */
export async function updatePlugin(packageName: string, userDataPath: string): Promise<InstallResult> {
  const pluginsDir = getPluginsDir(userDataPath)

  log.info(`Updating plugin: ${packageName}`)

  try {
    await npmExec(['update', packageName], pluginsDir)
    log.info(`Plugin updated: ${packageName}`)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error(`Failed to update plugin "${packageName}":`, err)
    return { success: false, error: errorMsg }
  }
}

function npmExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFile(npmCmd, args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`npm ${args[0]} failed: ${stderr || error.message}`))
      } else {
        resolve(stdout)
      }
    })
  })
}

/**
 * 在 node_modules 中查找刚安装的插件 ID
 */
function findInstalledPluginId(nodeModules: string, _spec: string): string | undefined {
  if (!fs.existsSync(nodeModules)) return undefined

  try {
    const entries = fs.readdirSync(nodeModules, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      // scoped packages
      if (entry.name.startsWith('@')) {
        const scopedDir = path.join(nodeModules, entry.name)
        const subEntries = fs.readdirSync(scopedDir, { withFileTypes: true })
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory()) continue
          const manifest = loadManifest(path.join(scopedDir, subEntry.name))
          if (manifest) return manifest.id
        }
        continue
      }

      const manifest = loadManifest(path.join(nodeModules, entry.name))
      if (manifest) return manifest.id
    }
  } catch { /* ignore */ }

  return undefined
}
