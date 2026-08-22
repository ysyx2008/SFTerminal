/** 桌面提示音：任务完成 / 失败 / 待批准 */

export type CueSoundKind = 'complete' | 'failed' | 'confirm'

export interface CueSoundSettings {
  enabled: boolean
  /** 用户替换的音频（data URL）；缺省用内置默认音 */
  custom: Partial<Record<CueSoundKind, string>>
}

export const DEFAULT_CUE_SOUND_SETTINGS: CueSoundSettings = {
  enabled: true,
  custom: {},
}
