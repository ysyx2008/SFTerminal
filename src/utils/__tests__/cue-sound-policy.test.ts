import { describe, expect, it } from 'vitest'
import { applyMasterCueEnabled, DEFAULT_CUE_SOUND_SETTINGS, isCueKindEnabled, normalizeCueSoundSettings } from '@shared/types'
import {
  resolveCompleteCueKind,
  shouldPlayConfirmCue,
  shouldPlayFailedCue,
} from '../cue-sound-policy'

describe('cue-sound-policy', () => {
  it('plays complete for ordinary tasks', () => {
    expect(resolveCompleteCueKind(['tab-abc'])).toBe('complete')
    expect(resolveCompleteCueKind(['assistant-uuid'])).toBe('complete')
  })

  it('does not use the task-complete chime for companion turns', () => {
    expect(resolveCompleteCueKind(['__companion__'])).toBeNull()
    expect(resolveCompleteCueKind(['tab-1', '__companion__'])).toBeNull()
  })

  it('stays silent when the user stopped the run', () => {
    expect(resolveCompleteCueKind(['tab-abc'], true)).toBeNull()
    expect(resolveCompleteCueKind(['__companion__'], true)).toBeNull()
  })

  it('stays silent for watch and wakeup', () => {
    expect(resolveCompleteCueKind(['__watch__:w1'])).toBeNull()
    expect(resolveCompleteCueKind(['__wakeup__'])).toBeNull()
    expect(shouldPlayFailedCue(['__watch__'])).toBe(false)
    expect(shouldPlayConfirmCue(['__wakeup__'])).toBe(false)
  })

  it('stays silent when no agent key can be attributed', () => {
    expect(resolveCompleteCueKind([])).toBeNull()
    expect(shouldPlayFailedCue([undefined])).toBe(false)
  })

  it('still plays failed/confirm for user-visible conversations', () => {
    expect(shouldPlayFailedCue(['tab-abc'])).toBe(true)
    expect(shouldPlayConfirmCue(['__companion__'])).toBe(true)
  })
})

describe('cue-sound settings switches', () => {
  it('master off silences every kind', () => {
    const s = normalizeCueSoundSettings({ enabled: false })
    expect(isCueKindEnabled('complete', s)).toBe(false)
    expect(isCueKindEnabled('message', s)).toBe(false)
  })

  it('lets one kind be turned off while the master stays on', () => {
    const s = normalizeCueSoundSettings({
      enabled: true,
      kindEnabled: { failed: false },
    })
    expect(isCueKindEnabled('complete', s)).toBe(true)
    expect(isCueKindEnabled('failed', s)).toBe(false)
    expect(isCueKindEnabled('message', s)).toBe(true)
  })

  it('maps the old companion-only switch onto the message kind', () => {
    const s = normalizeCueSoundSettings({ enabled: true, companionEnabled: false })
    expect(isCueKindEnabled('message', s)).toBe(false)
    expect(isCueKindEnabled('complete', s)).toBe(true)
  })

  it('defaults to all on', () => {
    expect(isCueKindEnabled('confirm', DEFAULT_CUE_SOUND_SETTINGS)).toBe(true)
    expect(DEFAULT_CUE_SOUND_SETTINGS.volume).toBe(1)
  })

  it('clamps shared volume to 0–1 and defaults missing to full', () => {
    expect(normalizeCueSoundSettings({}).volume).toBe(1)
    expect(normalizeCueSoundSettings({ volume: 0.4 }).volume).toBe(0.4)
    expect(normalizeCueSoundSettings({ volume: 1.8 }).volume).toBe(1)
    expect(normalizeCueSoundSettings({ volume: -2 }).volume).toBe(0)
  })

  it('master off turns every kind off, master on turns every kind on', () => {
    const off = applyMasterCueEnabled(
      normalizeCueSoundSettings({ enabled: true, kindEnabled: { failed: false } }),
      false,
    )
    expect(off.enabled).toBe(false)
    expect(off.kindEnabled.complete).toBe(false)
    expect(off.kindEnabled.failed).toBe(false)
    expect(off.kindEnabled.message).toBe(false)

    const on = applyMasterCueEnabled(off, true)
    expect(on.enabled).toBe(true)
    expect(on.kindEnabled.complete).toBe(true)
    expect(on.kindEnabled.failed).toBe(true)
    expect(on.kindEnabled.message).toBe(true)
  })
})
