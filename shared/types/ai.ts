/**
 * AI 相关共享类型（IPC 边界）
 *
 * 这些类型在前后端之间通过 IPC 序列化传递，是单一真相来源。
 * 后端 service、preload、前端 store 一律从 `@shared/types` 导入，
 * 禁止重复定义。
 */

/** AI 模型类型 */
export type AiModelType = 'general' | 'vision'

/** API 协议格式 */
export type ApiFormat = 'auto' | 'openai' | 'anthropic'

/** AI Profile（API endpoint + 模型配置） */
export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  /** 模型上下文长度（tokens），默认 128000 */
  contextLength?: number
  /** 单次回复最大输出 token 数，默认 8192 */
  maxOutputTokens?: number
  /** 采样温度，留空则自动选择（默认 0.7，部分模型如 Kimi K2.5 强制为 1） */
  temperature?: number
  /** 模型类型，默认 general */
  modelType?: AiModelType
  /** 关联的视觉模型 Profile ID（仅 general 类型有效） */
  visionProfileId?: string
  /** API 协议格式，默认 auto（自动检测） */
  apiFormat?: ApiFormat
}

/** 等待模型首 token 时随机展示的文案子键（前后端 i18n 共用） */
export const WAITING_FOR_MODEL_LABEL_IDS = [
  'diving',
  'scanning',
  'waitingWave',
  'booting',
  'neurons',
  'inspiration',
  'calling',
] as const

/** 5% 概率出现的彩蛋文案 */
export const WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS = [
  'coffee',
  'bribingGpu',
  'quantum',
  'yoda',
  'haggling',
] as const

/** TTFT 超过阈值后切换的调侃文案 */
export const WAITING_FOR_MODEL_SLOW_LABEL_IDS = [
  'slacking',
  'patience',
  'deepBreath',
  'novel',
  'almostThere',
] as const

export type WaitingForModelLabelId = (typeof WAITING_FOR_MODEL_LABEL_IDS)[number]
export type WaitingForModelEasterEggLabelId = (typeof WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS)[number]
export type WaitingForModelSlowLabelId = (typeof WAITING_FOR_MODEL_SLOW_LABEL_IDS)[number]

/** 彩蛋文案出现概率 */
export const WAITING_FOR_MODEL_EASTER_EGG_CHANCE = 0.05

/** 超过此 TTFT（ms）后切换为 slow 调侃文案 */
export const WAITING_FOR_MODEL_SLOW_TTFT_MS = 10_000
