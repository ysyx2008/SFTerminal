import { describe, expect, it } from 'vitest'
import { applyBondLineParams } from '../useWelcomeSubtitle'

describe('applyBondLineParams', () => {
  it('replaces days placeholder', () => {
    expect(
      applyBondLineParams('相伴 {days} 天', {
        daysTogether: 47,
        level: 50,
        trustLevel: 'companion',
        tasksCompleted: 10,
        executionMode: 'relaxed',
        milestones: [],
        lastCalculatedAt: 0,
      })
    ).toBe('相伴 47 天')
  })
})
