import { describe, expect, it, vi } from 'vitest'
import { pickTaskCompleteLabel } from '../useTaskCompleteLabel'

const pools = {
  default: ['任务完成', '搞定了'],
  ocean: ['到岸了'],
  bondCompanion: ['收工，背鳍放下了'],
}

describe('pickTaskCompleteLabel', () => {
  const t = vi.fn((key: string) => key)

  it('uses default pool when random is above fun chance', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValueOnce(0)
    expect(pickTaskCompleteLabel(pools, 'stranger', t)).toBe('任务完成')
    vi.restoreAllMocks()
  })

  it('uses fun pool when random is below fun chance', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    expect(pickTaskCompleteLabel(pools, 'stranger', t)).toBe('到岸了')
    vi.restoreAllMocks()
  })

  it('respects bond gates for fun pool', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    expect(pickTaskCompleteLabel(pools, 'companion', t)).toMatch(/到岸了|收工，背鳍放下了/)
    vi.restoreAllMocks()
  })

  it('returns neutral label when funEnabled is false', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    expect(pickTaskCompleteLabel(pools, 'companion', t, { funEnabled: false })).toBe('ai.taskComplete')
    vi.restoreAllMocks()
  })
})
