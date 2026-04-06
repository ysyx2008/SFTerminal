/**
 * TTS (Text-to-Speech) Provider 类型定义
 *
 * 可插拔的语音合成接口，内置 OpenAI 兼容实现，插件可通过
 * registerTtsProvider 注册自定义 provider。
 */

export interface TtsProvider {
  id: string
  name: string
  /** 将文本合成为音频，signal 用于取消请求 */
  synthesize(text: string, options: TtsSynthesizeOptions, signal?: AbortSignal): Promise<TtsSynthesizeResult>
  /** 获取可用声色列表（可选） */
  getVoices?(): Promise<TtsVoice[]>
  /** 释放资源 */
  dispose?(): void
}

export interface TtsSynthesizeOptions {
  voice?: string
  model?: string
  speed?: number
  /** 输出格式偏好，provider 可忽略 */
  responseFormat?: TtsAudioFormat
}

export type TtsAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'

export interface TtsSynthesizeResult {
  /** 音频二进制数据 */
  audio: Buffer
  /** 实际输出格式 */
  format: TtsAudioFormat
  sampleRate?: number
}

export interface TtsVoice {
  id: string
  name: string
  language?: string
  gender?: string
  previewUrl?: string
}

export type { TtsSettings } from '@shared/types'
export { DEFAULT_TTS_SETTINGS } from '@shared/types'
