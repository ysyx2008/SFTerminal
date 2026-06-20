import { describe, it, expect } from 'vitest'
import { t } from '../i18n'
import {
  WAITING_FOR_MODEL_LABEL_IDS,
  WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS,
  WAITING_FOR_MODEL_SLOW_LABEL_IDS,
  waitingForModelI18nKey,
} from '@shared/types/ai'

describe('waitingForModelI18nKey', () => {
  it('resolves all label ids in backend i18n', () => {
    const cases: Array<{ id: string; variant?: 'default' | 'easter' | 'slow' }> = [
      ...WAITING_FOR_MODEL_LABEL_IDS.map(id => ({ id })),
      ...WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS.map(id => ({ id, variant: 'easter' as const })),
      ...WAITING_FOR_MODEL_SLOW_LABEL_IDS.map(id => ({ id, variant: 'slow' as const })),
    ]

    for (const { id, variant = 'default' } of cases) {
      const key = waitingForModelI18nKey(id, variant)
      const text = t(key as Parameters<typeof t>[0])
      expect(text).not.toBe(key)
      expect(text.length).toBeGreaterThan(0)
    }
  })
})
