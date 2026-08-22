/**
 * TTS 服务
 *
 * 管理 TTS provider 的注册（内置 + 插件）和语音合成路由。
 * 模块级状态，通过动态 import 懒加载（与 speech/index.ts 模式一致）。
 */

import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult, TtsVoice, TtsSettings } from './types'
import { DEFAULT_TTS_SETTINGS } from './types'
import { OpenAICompatTtsProvider, setSettingsGetter } from './openai-provider'
import { VolcengineTtsProvider, setVolcengineSettingsGetter } from './volcengine-provider'
import { DashScopeTtsProvider, setDashScopeSettingsGetter } from './dashscope-provider'
import { createLogger } from '../../utils/logger'

const log = createLogger('TTS')

const providers = new Map<string, TtsProvider>()
let currentSettings: TtsSettings = { ...DEFAULT_TTS_SETTINGS }
let initialized = false

/** 跟踪所有进行中的合成请求，以便统一取消 */
const activeControllers = new Set<AbortController>()

/**
 * 确保内置 provider 已注册（幂等）
 */
export function ensureInitialized(): void {
  if (initialized) return
  try {
    registerBuiltinProviders()
    initialized = true
  } catch (err) {
    log.error('Failed to initialize builtin TTS providers:', err)
  }
}

/**
 * 注册内置 provider
 */
export function registerBuiltinProviders(): void {
  const getter = () => getSettings()
  setSettingsGetter(getter)
  setVolcengineSettingsGetter(getter)
  setDashScopeSettingsGetter(getter)

  for (const P of [OpenAICompatTtsProvider, VolcengineTtsProvider, DashScopeTtsProvider]) {
    const provider = new P()
    registerProvider(provider)
  }
  log.info(`Builtin TTS providers registered: ${providers.size}`)
}

/**
 * 注册 provider（插件或内置）
 */
export function registerProvider(provider: TtsProvider): void {
  if (providers.has(provider.id)) {
    log.warn(`TTS provider "${provider.id}" already registered, overwriting`)
    providers.get(provider.id)?.dispose?.()
  }
  providers.set(provider.id, provider)
  log.info(`TTS provider registered: ${provider.id} (${provider.name})`)
}

/**
 * 移除 provider
 */
export function removeProvider(id: string): void {
  const provider = providers.get(id)
  if (provider) {
    provider.dispose?.()
    providers.delete(id)
    log.info(`TTS provider removed: ${id}`)
  }
}

/**
 * 更新配置
 */
export function updateSettings(settings: TtsSettings): void {
  currentSettings = { ...settings }
}

/**
 * 获取当前配置
 */
export function getSettings(): TtsSettings {
  return { ...currentSettings }
}

/**
 * 获取所有已注册的 provider
 */
export function getProviders(): Array<{ id: string; name: string }> {
  return Array.from(providers.values()).map(p => ({ id: p.id, name: p.name }))
}

/**
 * 合成语音
 */
export async function synthesize(
  text: string,
  options?: Partial<TtsSynthesizeOptions>
): Promise<TtsSynthesizeResult> {
  const provider = providers.get(currentSettings.providerId)
  if (!provider) {
    throw new Error(`TTS provider "${currentSettings.providerId}" not found`)
  }

  const mergedOptions: TtsSynthesizeOptions = {
    voice: options?.voice ?? currentSettings.voice,
    model: options?.model ?? currentSettings.model,
    speed: options?.speed ?? currentSettings.speed,
    responseFormat: options?.responseFormat ?? 'mp3',
  }

  const controller = new AbortController()
  activeControllers.add(controller)

  try {
    const result = await provider.synthesize(text, mergedOptions, controller.signal)
    return result
  } finally {
    activeControllers.delete(controller)
  }
}

/**
 * 取消所有进行中的合成请求
 */
export function stopSynthesis(): void {
  for (const controller of activeControllers) {
    controller.abort()
  }
  activeControllers.clear()
}

/**
 * 获取当前 provider 的可用声色
 */
export async function getVoices(): Promise<TtsVoice[]> {
  const provider = providers.get(currentSettings.providerId)
  if (!provider?.getVoices) {
    return []
  }
  return provider.getVoices()
}

/**
 * 释放所有资源
 */
export function dispose(): void {
  stopSynthesis()
  for (const provider of providers.values()) {
    provider.dispose?.()
  }
  providers.clear()
  initialized = false
  log.info('TTS service disposed')
}
