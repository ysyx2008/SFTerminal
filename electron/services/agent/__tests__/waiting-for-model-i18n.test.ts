import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import zhCN from '../../../../src/i18n/locales/zh-CN/index'
import { t } from '../i18n'
import {
  WAITING_FOR_MODEL_LABEL_IDS,
  WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS,
  WAITING_FOR_MODEL_SLOW_LABEL_IDS,
  waitingForModelI18nKey,
} from '@shared/types/ai'

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })
const frontendT = i18n.global.t

describe('waitingForModelI18nKey', () => {
  it('resolves on backend and frontend with the same key path', () => {
    const cases: Array<{ id: string; variant?: 'default' | 'easter' | 'slow' }> = [
      ...WAITING_FOR_MODEL_LABEL_IDS.map(id => ({ id })),
      ...WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS.map(id => ({ id, variant: 'easter' as const })),
      ...WAITING_FOR_MODEL_SLOW_LABEL_IDS.map(id => ({ id, variant: 'slow' as const })),
    ]

    for (const { id, variant = 'default' } of cases) {
      const key = waitingForModelI18nKey(id, variant)
      const backend = t(key as Parameters<typeof t>[0])
      const frontend = frontendT(key)

      expect(backend).not.toBe(key)
      expect(frontend).not.toBe(key)
      expect(backend).toBe(frontend)
    }
  })
})
