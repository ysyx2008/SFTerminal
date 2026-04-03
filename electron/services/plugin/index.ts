/**
 * 插件系统入口
 */

export { PluginRegistry, createPluginRegistry, getPluginRegistry } from './registry'
export type { PluginRegistryConfig } from './registry'
export { HookBus } from './hook-bus'
export { installPlugin, uninstallPlugin, updatePlugin } from './installer'
export type {
  PluginManifest,
  PluginEntry,
  LoadedPlugin,
  PluginRegistrationAPI,
  ToolRegistration,
  ToolExecuteResult,
  ProviderRegistration,
  ChannelRegistration,
  HookEvent,
  HookHandler,
  HookDecision,
  HttpRouteEntry,
  PluginEntryConfig
} from './types'
