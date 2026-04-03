/**
 * 插件注册表
 * 
 * 管理插件的完整生命周期：发现、加载、启用/禁用、工具聚合、执行分发。
 * 是插件系统对外的主要接口，被 AgentService、GatewayService 等消费。
 */

import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../ai.service'
import type {
  LoadedPlugin,
  PluginEntryConfig,
  ProviderRegistration,
  ChannelRegistration,
  HttpRouteEntry,
  ToolExecuteResult,
  HookEvent
} from './types'
import { discoverPluginDirs, loadManifest, loadPlugin } from './loader'
import { HookBus } from './hook-bus'
import { createLogger } from '../../utils/logger'

const log = createLogger('PluginRegistry')

/** 工具名前缀，类似 MCP 的 mcp_ */
const TOOL_PREFIX = 'plugin_'

export interface PluginRegistryConfig {
  enabled: boolean
  allow?: string[]
  deny?: string[]
  loadPaths?: string[]
  entries?: Record<string, PluginEntryConfig>
  userDataPath: string
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>()
  /** 插件工具名 -> (pluginId, 原始 toolName) 的映射 */
  private toolNameMap = new Map<string, { pluginId: string; originalName: string }>()
  readonly hookBus = new HookBus()
  private config: PluginRegistryConfig

  constructor(config: PluginRegistryConfig) {
    this.config = config
  }

  /**
   * 扫描所有插件目录、加载 manifest、import 入口、调用 register(api)
   */
  async loadAll(): Promise<void> {
    if (!this.config.enabled) {
      log.info('Plugin system disabled')
      return
    }

    // 注册 OpenClaw SDK shim（必须在 import 插件模块之前）
    registerSdkShim()

    const baseDirs = this.getDiscoveryPaths()
    log.info(`Scanning plugin directories: ${baseDirs.join(', ')}`)
    const pluginDirs = discoverPluginDirs(baseDirs)
    log.info(`Found ${pluginDirs.length} plugin(s)`)

    for (const dir of pluginDirs) {
      const manifest = loadManifest(dir)
      if (!manifest) continue

      if (this.plugins.has(manifest.id)) {
        log.info(`Plugin "${manifest.id}" already loaded, skipping duplicate from ${dir}`)
        continue
      }

      if (!this.isAllowed(manifest.id)) {
        log.info(`Plugin "${manifest.id}" is denied by config, skipping`)
        continue
      }

      try {
        const plugin = await loadPlugin(dir, manifest)
        plugin.enabled = this.isEnabled(manifest.id, manifest.enabledByDefault)
        this.plugins.set(manifest.id, plugin)

        if (plugin.enabled) {
          this.activatePlugin(plugin)
        }
      } catch (err) {
        log.error(`Failed to load plugin from ${dir}:`, err)
      }
    }

    log.info(
      `Plugin loading complete: ${this.plugins.size} loaded, ` +
      `${this.toolNameMap.size} tools, ` +
      `${this.getAllProviders().length} providers, ` +
      `${this.getAllChannels().length} channels`
    )
  }

  /** 激活插件：注册工具名映射、hook */
  private activatePlugin(plugin: LoadedPlugin): void {
    const pluginId = plugin.manifest.id

    // 工具名映射
    for (const tool of plugin.tools) {
      const mappedName = this.mapToolName(pluginId, tool.name)
      this.toolNameMap.set(mappedName, { pluginId, originalName: tool.name })
    }

    // hook 注册到全局 HookBus
    for (const [event, handlers] of plugin.hooks) {
      for (const handler of handlers) {
        this.hookBus.register(pluginId, event, handler)
      }
    }
  }

  /** 停用插件：移除工具映射、hook */
  private deactivatePlugin(plugin: LoadedPlugin): void {
    const pluginId = plugin.manifest.id

    // 移除工具映射
    for (const [mappedName, info] of this.toolNameMap) {
      if (info.pluginId === pluginId) {
        this.toolNameMap.delete(mappedName)
      }
    }

    // 移除 hook
    this.hookBus.removePlugin(pluginId)
  }

  // ==================== 工具聚合 ====================

  /**
   * 获取所有已启用插件的工具定义（转换为 SailFish ToolDefinition 格式）
   */
  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = []

    for (const [pluginId, plugin] of this.plugins) {
      if (!plugin.enabled) continue
      for (const tool of plugin.tools) {
        const mappedName = this.mapToolName(pluginId, tool.name)
        definitions.push({
          type: 'function',
          function: {
            name: mappedName,
            description: tool.description,
            parameters: tool.parameters as ToolDefinition['function']['parameters']
          }
        })
      }
    }

    return definitions
  }

  /**
   * 执行插件工具调用
   * 将 OpenClaw 格式的结果转换为 SailFish 的 ToolResult
   */
  async executeTool(
    mappedName: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<{ success: boolean; output: string; error?: string; images?: string[] } | null> {
    const mapping = this.toolNameMap.get(mappedName)
    if (!mapping) return null

    const plugin = this.plugins.get(mapping.pluginId)
    if (!plugin || !plugin.enabled) return null

    const tool = plugin.tools.find(t => t.name === mapping.originalName)
    if (!tool) return null

    try {
      const TOOL_TIMEOUT_MS = 60_000
      const result = await Promise.race([
        tool.execute(toolCallId, args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Plugin tool "${mappedName}" timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
        )
      ])
      return this.convertToolResult(result)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error(`Plugin tool "${mappedName}" failed:`, err)
      return { success: false, output: '', error: errorMsg }
    }
  }

  /** 检查工具名是否属于插件 */
  isPluginTool(name: string): boolean {
    return name.startsWith(TOOL_PREFIX) && this.toolNameMap.has(name)
  }

  // ==================== Provider / Channel / Route 聚合 ====================

  getAllProviders(): ProviderRegistration[] {
    const providers: ProviderRegistration[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) providers.push(...plugin.providers)
    }
    return providers
  }

  getAllChannels(): ChannelRegistration[] {
    const channels: ChannelRegistration[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) channels.push(...plugin.channels)
    }
    return channels
  }

  getAllHttpRoutes(): HttpRouteEntry[] {
    const routes: HttpRouteEntry[] = []
    for (const plugin of this.plugins.values()) {
      if (plugin.enabled) routes.push(...plugin.httpRoutes)
    }
    return routes
  }

  // ==================== 插件管理 ====================

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id)
  }

  listAll(): Array<{ id: string; name?: string; description?: string; version?: string; enabled: boolean; toolCount: number }> {
    return Array.from(this.plugins.values()).map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.manifest.version,
      enabled: p.enabled,
      toolCount: p.tools.length
    }))
  }

  enablePlugin(id: string): boolean {
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.enabled) return false
    plugin.enabled = true
    this.activatePlugin(plugin)
    log.info(`Plugin "${id}" enabled`)
    return true
  }

  disablePlugin(id: string): boolean {
    const plugin = this.plugins.get(id)
    if (!plugin || !plugin.enabled) return false
    plugin.enabled = false
    this.deactivatePlugin(plugin)
    log.info(`Plugin "${id}" disabled`)
    return true
  }

  updateConfig(config: Partial<PluginRegistryConfig>): void {
    Object.assign(this.config, config)
  }

  // ==================== 内部方法 ====================

  private getDiscoveryPaths(): string[] {
    const dirs: string[] = []

    // 1. 配置指定路径
    if (this.config.loadPaths) {
      dirs.push(...this.config.loadPaths)
    }

    // 2. 用户数据目录下的 plugins/
    const userPluginsDir = path.join(this.config.userDataPath, 'plugins')
    dirs.push(userPluginsDir)

    // 3. npm install 安装的插件（在 plugins/node_modules 下）
    const npmModulesDir = path.join(userPluginsDir, 'node_modules')
    if (!dirs.includes(npmModulesDir)) {
      dirs.push(npmModulesDir)
    }

    // 4. OpenClaw 全局扩展目录
    const openclawDir = path.join(os.homedir(), '.openclaw', 'extensions')
    dirs.push(openclawDir)

    return dirs
  }

  /** 工具名映射：plugin_{pluginId}_{toolName} */
  private mapToolName(pluginId: string, toolName: string): string {
    const safePluginId = pluginId.replace(/[^a-zA-Z0-9]/g, '_')
    const safeToolName = toolName.replace(/[^a-zA-Z0-9_]/g, '_')
    return `${TOOL_PREFIX}${safePluginId}_${safeToolName}`
  }

  /** 将 OpenClaw 工具结果转换为 SailFish ToolResult */
  private convertToolResult(result: ToolExecuteResult): {
    success: boolean; output: string; error?: string; images?: string[]
  } {
    const texts: string[] = []
    const images: string[] = []

    for (const item of result.content) {
      if (item.type === 'text') {
        texts.push(item.text)
      } else if (item.type === 'image') {
        images.push(item.data)
      }
    }

    return {
      success: true,
      output: texts.join('\n'),
      images: images.length > 0 ? images : undefined
    }
  }

  private isAllowed(pluginId: string): boolean {
    if (this.config.deny?.includes(pluginId)) return false
    if (this.config.allow && !this.config.allow.includes(pluginId)) return false
    return true
  }

  private isEnabled(pluginId: string, enabledByDefault?: true): boolean {
    const entryConfig = this.config.entries?.[pluginId]
    if (entryConfig) return entryConfig.enabled
    return enabledByDefault === true
  }
}

// ==================== SDK Shim 注册 ====================

let sdkShimRegistered = false

const shimExports = {
  definePluginEntry: (entry: unknown) => entry,
  defineChannelPluginEntry: (entry: unknown) => entry,
  createPluginRuntimeStore: () => {
    const store: Record<string, unknown> = {}
    return {
      get(key: string) { return store[key] },
      set(key: string, value: unknown) { store[key] = value },
      getAll() { return { ...store } },
      clear() { for (const k of Object.keys(store)) delete store[k] }
    }
  }
}

/**
 * 注册 OpenClaw SDK 模块解析拦截
 * 让 `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"` 等指向我们的 shim
 *
 * 通过预填 require.cache + 拦截 _resolveFilename 实现，无需外部 .js 文件
 */
function registerSdkShim(): void {
  if (sdkShimRegistered) return
  sdkShimRegistered = true

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module')
    const SHIM_KEY = '__openclaw_plugin_sdk_shim__'

    // 预填 cache，使 require(SHIM_KEY) 直接返回 shimExports
    const m = new Module(SHIM_KEY)
    m.exports = { ...shimExports, default: shimExports }
    m.loaded = true
    require.cache[SHIM_KEY] = m

    const origResolve = Module._resolveFilename
    Module._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (typeof request === 'string' && request.startsWith('openclaw/plugin-sdk')) {
        return SHIM_KEY
      }
      return origResolve.call(this, request, ...rest)
    }

    log.info('OpenClaw SDK shim registered')
  } catch (err) {
    log.warn('Failed to register OpenClaw SDK shim (non-fatal):', err)
  }
}

// ==================== 单例工厂 ====================

let instance: PluginRegistry | null = null

export function getPluginRegistry(): PluginRegistry | null {
  return instance
}

export function createPluginRegistry(config: PluginRegistryConfig): PluginRegistry {
  instance = new PluginRegistry(config)
  return instance
}
