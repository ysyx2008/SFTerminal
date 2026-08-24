import { describe, it, expect, vi } from 'vitest'
import { runUntilIdle } from '../run-until-idle'

describe('runUntilIdle', () => {
  it('waits for a late child knock instead of finishing after the first no-tool pass', async () => {
    let loopCount = 0
    let pending = false
    let childLive = true

    const result = await runUntilIdle({
      executeLoop: async () => {
        loopCount++
        pending = false
        if (loopCount === 1) return 'first-pass-no-tools'
        return 'heard-knock'
      },
      hasPendingMessages: () => pending,
      hasLiveChildren: () => childLive,
      waitForChildrenOrKnock: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        childLive = false
        pending = true
      },
      isAborted: () => false,
    })

    expect(loopCount).toBe(2)
    expect(result).toBe('heard-knock')
  })

  it('does not wait when no children are live', async () => {
    const executeLoop = vi.fn().mockResolvedValue('done')
    const waitForChildrenOrKnock = vi.fn()

    const result = await runUntilIdle({
      executeLoop,
      hasPendingMessages: () => false,
      hasLiveChildren: () => false,
      waitForChildrenOrKnock,
      isAborted: () => false,
    })

    expect(result).toBe('done')
    expect(executeLoop).toHaveBeenCalledTimes(1)
    expect(waitForChildrenOrKnock).not.toHaveBeenCalled()
  })
})
