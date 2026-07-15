import { describe, expect, it } from 'vitest'
import { deriveContextBarFromSteps } from '@shared/types'

describe('deriveContextBarFromSteps', () => {
  it('returns undefined when no step has contextTokens', () => {
    expect(deriveContextBarFromSteps([
      { contextTokens: undefined },
    ])).toBeUndefined()
  })

  it('reads the latest step with contextTokens', () => {
    const bar = deriveContextBarFromSteps([
      { contextTokens: 100, cacheHitRate: 10, effectiveModel: 'A' },
      {},
      { contextTokens: 200, cacheHitRate: 50, effectiveContextLength: 256000, effectiveModel: 'B' },
    ])
    expect(bar).toEqual({
      contextTokens: 200,
      cacheHitRate: 50,
      effectiveContextLength: 256000,
      effectiveModel: 'B',
    })
  })
})
