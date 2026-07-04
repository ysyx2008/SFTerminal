import { describe, it, expect } from 'vitest'
import { commandNeedsConfirm, isSubAgentBlocked } from '../confirm-policy'
import type { CommandRiskAssessment } from '../types'

function assessment(
  level: CommandRiskAssessment['level'],
  hasUnknown = false,
): CommandRiskAssessment {
  return { level, parsed: true, calls: [], hasUnknown }
}

describe('confirm-policy', () => {
  it('relaxed: unknown moderate 仍需确认', () => {
    expect(commandNeedsConfirm(assessment('moderate', true), 'relaxed')).toBe(true)
  })

  it('relaxed: 已知 safe 不确认', () => {
    expect(commandNeedsConfirm(assessment('safe', false), 'relaxed')).toBe(false)
  })

  it('relaxed: dangerous 确认', () => {
    expect(commandNeedsConfirm(assessment('dangerous'), 'relaxed')).toBe(true)
  })

  it('free: unknown 也不确认', () => {
    expect(commandNeedsConfirm(assessment('moderate', true), 'free')).toBe(false)
  })

  it('sub-agent 阻止 unknown', () => {
    expect(isSubAgentBlocked(assessment('moderate', true))).toBe(true)
  })
})
