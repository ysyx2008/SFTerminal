import { describe, expect, it, vi } from 'vitest'
import { formatBondMilestoneToast } from '../useBondMilestoneToasts'

describe('formatBondMilestoneToast', () => {
  const t = vi.fn((key: string, params?: Record<string, unknown>) => {
    if (key === 'bond.milestone.bond_old_friend.title') return '羁绊 · 莫逆之交'
    if (key === 'bond.milestone.bond_old_friend.body') return `相伴 ${params?.days} 天，这羁绊值了。`
    return key
  })

  it('combines title and body with em dash', () => {
    const message = formatBondMilestoneToast(t, 'bond_old_friend', { daysTogether: 60, level: 62 })
    expect(message).toBe('羁绊 · 莫逆之交 — 相伴 60 天，这羁绊值了。')
  })
})
