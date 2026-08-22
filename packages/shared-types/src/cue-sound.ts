/** 桌面提示音：任务完成 / 失败 / 待批准 / 联络来信 */

export const CUE_SOUND_KINDS = ['complete', 'failed', 'confirm', 'message'] as const

export type CueSoundKind = (typeof CUE_SOUND_KINDS)[number]

export interface CueSoundSettings {
  /** 总开关：关掉则四声都不响 */
  enabled: boolean
  /** 各声单独开关；缺省为开 */
  kindEnabled: Partial<Record<CueSoundKind, boolean>>
  /** 用户替换的音频（data URL）；缺省用内置默认音 */
  custom: Partial<Record<CueSoundKind, string>>
}

export const DEFAULT_CUE_SOUND_SETTINGS: CueSoundSettings = {
  enabled: true,
  kindEnabled: {},
  custom: {},
}

function allKinds(on: boolean): Record<CueSoundKind, boolean> {
  return {
    complete: on,
    failed: on,
    confirm: on,
    message: on,
  }
}

/** 读盘时补齐；旧版 companionEnabled 收进联络来信那一档 */
export function normalizeCueSoundSettings(
  raw?: (Partial<CueSoundSettings> & { companionEnabled?: boolean }) | null,
): CueSoundSettings {
  const kindEnabled = raw?.kindEnabled && typeof raw.kindEnabled === 'object'
    ? { ...raw.kindEnabled }
    : {}
  if (raw?.companionEnabled === false && kindEnabled.message === undefined) {
    kindEnabled.message = false
  }
  const custom = raw?.custom && typeof raw.custom === 'object' ? { ...raw.custom } : {}
  return {
    enabled: raw?.enabled !== false,
    kindEnabled,
    custom,
  }
}

/** 拨总开关：关则四声都关，开则四声都开，不保留各自旧状态 */
export function applyMasterCueEnabled(settings: CueSoundSettings, enabled: boolean): CueSoundSettings {
  return {
    ...settings,
    enabled,
    kindEnabled: allKinds(enabled),
  }
}

export function isCueKindEnabled(kind: CueSoundKind, settings: CueSoundSettings): boolean {
  if (settings.enabled === false) return false
  return settings.kindEnabled[kind] !== false
}
