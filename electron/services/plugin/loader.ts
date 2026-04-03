/**
 * 插件加载器
 * 
 * 职责：目录扫描、manifest 解析、模块动态加载、调用 register(api) 收集注册物。
 * 兼容 OpenClaw 的 openclaw.plugin.json manifest 格式。
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  PluginManifest,
  PluginEntry,
  LoadedPlugin,
  PluginRegistrationAPI,
  ToolRegistration,
  ToolRegistrationOptions,
  ProviderRegistration,
  ChannelRegistration,
  HookEvent,
  HookHandler,
  RouteHandler
} from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('PluginLoader')

const MANIFEST_FILENAME = 'openclaw.plugin.json'

/**
 * 从指定目录扫描所有插件目录
 * 每个子目录如果含有 openclaw.plugin.json 就视为一个插件
 */
export function discoverPluginDirs(baseDirs: string[]): string[] {
  const pluginDirs: string[] = []

  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) continue

    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const pluginDir = path.join(baseDir, entry.name)
        const manifestPath = path.join(pluginDir, MANIFEST_FILENAME)
        if (fs.existsSync(manifestPath)) {
          pluginDirs.push(pluginDir)
        }
        // 支持 scoped packages: @scope/plugin-name
        if (entry.name.startsWith('@')) {
          try {
            const scopedEntries = fs.readdirSync(pluginDir, { withFileTypes: true })
            for (const scopedEntry of scopedEntries) {
              if (!scopedEntry.isDirectory()) continue
              const scopedDir = path.join(pluginDir, scopedEntry.name)
              if (fs.existsSync(path.join(scopedDir, MANIFEST_FILENAME))) {
                pluginDirs.push(scopedDir)
              }
            }
          } catch { /* skip unreadable scoped dir */ }
        }
      }
    } catch (err) {
      log.warn(`Failed to scan plugin directory ${baseDir}:`, err)
    }
  }

  return pluginDirs
}

/**
 * 读取并校验插件 manifest
 */
export function loadManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = path.join(pluginDir, MANIFEST_FILENAME)
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw) as PluginManifest

    if (!manifest.id || typeof manifest.id !== 'string') {
      log.error(`Invalid manifest in ${pluginDir}: missing or invalid "id"`)
      return null
    }
    if (!manifest.configSchema || typeof manifest.configSchema !== 'object') {
      log.error(`Invalid manifest in ${pluginDir}: missing or invalid "configSchema"`)
      return null
    }
    return manifest
  } catch (err) {
    log.error(`Failed to read manifest from ${pluginDir}:`, err)
    return null
  }
}

/**
 * 加载插件模块并调用 register(api) 收集注册物
 */
export async function loadPlugin(
  pluginDir: string,
  manifest: PluginManifest
): Promise<LoadedPlugin> {
  const plugin: LoadedPlugin = {
    manifest,
    rootDir: pluginDir,
    tools: [],
    providers: [],
    channels: [],
    hooks: new Map(),
    httpRoutes: [],
    enabled: true
  }

  // 构建 Registration API
  const api = createRegistrationAPI(manifest.id, plugin)

  // 尝试加载插件入口模块
  try {
    const entryModule = await resolveAndImportEntry(pluginDir)
    if (entryModule) {
      const entry = extractPluginEntry(entryModule)
      if (entry) {
        plugin.entry = entry
        entry.register(api)
        log.info(
          `Plugin "${manifest.id}" loaded: ` +
          `${plugin.tools.length} tools, ` +
          `${plugin.providers.length} providers, ` +
          `${plugin.channels.length} channels, ` +
          `${plugin.httpRoutes.length} routes`
        )
      } else {
        log.warn(`Plugin "${manifest.id}" has no valid entry (no register function)`)
      }
    }
  } catch (err) {
    log.error(`Failed to load entry for plugin "${manifest.id}":`, err)
  }

  return plugin
}

function createRegistrationAPI(pluginId: string, plugin: LoadedPlugin): PluginRegistrationAPI {
  return {
    registerTool(def: ToolRegistration, opts?: ToolRegistrationOptions) {
      plugin.tools.push({ ...def, optional: opts?.optional })
      log.debug(`Plugin "${pluginId}" registered tool: ${def.name}`)
    },
    registerProvider(def: ProviderRegistration) {
      plugin.providers.push(def)
      log.debug(`Plugin "${pluginId}" registered provider: ${def.id}`)
    },
    registerChannel(def: ChannelRegistration) {
      plugin.channels.push(def)
      log.debug(`Plugin "${pluginId}" registered channel: ${def.id}`)
    },
    registerHook(event: HookEvent, handler: HookHandler) {
      let list = plugin.hooks.get(event)
      if (!list) {
        list = []
        plugin.hooks.set(event, list)
      }
      list.push(handler)
      log.debug(`Plugin "${pluginId}" registered hook: ${event}`)
    },
    registerHttpRoute(method: string, routePath: string, handler: RouteHandler) {
      plugin.httpRoutes.push({ method: method.toUpperCase(), path: routePath, handler })
      log.debug(`Plugin "${pluginId}" registered route: ${method.toUpperCase()} ${routePath}`)
    }
  }
}

/**
 * 解析插件入口并动态 import
 * 查找顺序：package.json openclaw.extensions → index.ts → index.js
 */
async function resolveAndImportEntry(pluginDir: string): Promise<unknown> {
  // 1. 检查 package.json 中的 openclaw.extensions
  const pkgPath = path.join(pluginDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const extensions = pkg.openclaw?.extensions as string[] | undefined
      if (extensions && extensions.length > 0) {
        const entryPath = path.resolve(pluginDir, extensions[0])
        return await dynamicImport(entryPath)
      }
      // fallback: main field
      if (pkg.main) {
        const entryPath = path.resolve(pluginDir, pkg.main)
        return await dynamicImport(entryPath)
      }
    } catch { /* fall through */ }
  }

  // 2. 常规入口文件
  for (const candidate of ['index.ts', 'index.js', 'index.mjs']) {
    const entryPath = path.join(pluginDir, candidate)
    if (fs.existsSync(entryPath)) {
      return await dynamicImport(entryPath)
    }
  }

  return null
}

async function dynamicImport(filePath: string): Promise<unknown> {
  if (filePath.endsWith('.mjs')) {
    // ESM 模块需要动态 import
    return await import(filePath)
  }
  // tsx 注册后可以直接 require .ts/.js 文件
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(filePath)
}

/**
 * 从模块导出中提取 PluginEntry
 * 支持 default export 和 named export
 */
function extractPluginEntry(mod: unknown): PluginEntry | null {
  if (!mod || typeof mod !== 'object') return null

  const m = mod as Record<string, unknown>

  // default export（最常见：export default definePluginEntry({...})）
  const defaultExport = m.default
  if (isPluginEntry(defaultExport)) return defaultExport

  // module 本身就是 entry
  if (isPluginEntry(m)) return m as unknown as PluginEntry

  return null
}

function isPluginEntry(obj: unknown): obj is PluginEntry {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.register === 'function'
}
