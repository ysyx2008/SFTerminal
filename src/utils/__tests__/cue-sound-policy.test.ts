import { describe, expect, it } from 'vitest'
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

  it('stays silent for companion until a distinct message sound exists', () => {
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
