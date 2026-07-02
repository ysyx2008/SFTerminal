import { describe, expect, it } from 'vitest'
import { filterPersistableSteps, isStartupPlaceholderStep } from '@shared/types/agent'
import type { AgentStep } from '@shared/types/agent'

const mk = (partial: Partial<AgentStep> & Pick<AgentStep, 'id' | 'type' | 'content'>): AgentStep => ({
  timestamp: Date.now(),
  ...partial,
})

describe('startup placeholder steps', () => {
  it('marks explicit and streaming thinking placeholders', () => {
    expect(isStartupPlaceholderStep(mk({ id: '1', type: 'thinking', content: 'x', placeholder: 'startup' }))).toBe(true)
    expect(isStartupPlaceholderStep(mk({ id: '2', type: 'thinking', content: 'x', isStreaming: true }))).toBe(true)
    expect(isStartupPlaceholderStep(mk({ id: '3', type: 'thinking', content: '⚠️ bad args' }))).toBe(false)
  })

  it('does not persist startup placeholders', () => {
    const steps = [
      mk({ id: 'u', type: 'user_task', content: 'hi' }),
      mk({ id: 'p', type: 'thinking', content: 'booting', placeholder: 'startup', isStreaming: true }),
      mk({ id: 'm', type: 'message', content: 'ok' }),
    ]
    expect(filterPersistableSteps(steps).map(s => s.id)).toEqual(['u', 'm'])
  })
})
