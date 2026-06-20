import { describe, expect, it } from 'vitest'
import { collectEligiblePlaceholders } from '../useRandomPlaceholder'

describe('collectEligiblePlaceholders', () => {
  const pools = {
    ocean: ['深海听你的…'],
    rivals: ['隔壁龙虾会夹手…'],
    bondCompanion: ['老搭档了…'],
    bondSoulmate: ['心意相通…'],
  }

  it('stranger only gets ocean pool', () => {
    expect(collectEligiblePlaceholders(pools, 'stranger')).toEqual(['深海听你的…'])
  })

  it('acquaintance unlocks rivals', () => {
    expect(collectEligiblePlaceholders(pools, 'acquaintance')).toEqual([
      '深海听你的…',
      '隔壁龙虾会夹手…',
    ])
  })

  it('companion unlocks bondCompanion', () => {
    const result = collectEligiblePlaceholders(pools, 'companion')
    expect(result).toContain('老搭档了…')
    expect(result).not.toContain('心意相通…')
  })

  it('soulmate gets all pools', () => {
    expect(collectEligiblePlaceholders(pools, 'soulmate')).toHaveLength(4)
  })
})
