/** TTS 配置，前后端共享 */
export interface TtsSettings {
  enabled: boolean
  providerId: string
  /** 服务商预设 ID（'openai' | 'siliconflow' | 'minimax' | 'volcengine' | 'custom'） */
  preset: string
  apiUrl: string
  apiKey: string
  model: string
  voice: string
  speed: number
  autoSpeak: boolean
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  providerId: 'openai-compat',
  preset: 'openai',
  apiUrl: 'https://api.openai.com/v1/audio/speech',
  apiKey: '',
  model: 'tts-1',
  voice: 'alloy',
  speed: 1.0,
  autoSpeak: false,
}
