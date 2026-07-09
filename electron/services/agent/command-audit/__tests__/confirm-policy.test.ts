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
  it('relaxed: unknown moderate 不再确认（只确认 dangerous/blocked）', () => {
    expect(commandNeedsConfirm(assessment('moderate', true), 'relaxed')).toBe(false)
  })

  it('relaxed: 已知 safe 不确认', () => {
    expect(commandNeedsConfirm(assessment('safe', false), 'relaxed')).toBe(false)
  })

  it('relaxed: dangerous 确认', () => {
    expect(commandNeedsConfirm(assessment('dangerous'), 'relaxed')).toBe(true)
  })

  it('relaxed: blocked 确认', () => {
    expect(commandNeedsConfirm(assessment('blocked'), 'relaxed')).toBe(true)
  })

  it('free: dangerous 也不确认', () => {
    expect(commandNeedsConfirm(assessment('dangerous'), 'free')).toBe(false)
  })

  it('sub-agent 阻止 dangerous', () => {
    expect(isSubAgentBlocked(assessment('dangerous'))).toBe(true)
  })

  it('sub-agent 阻止 blocked', () => {
    expect(isSubAgentBlocked(assessment('blocked'))).toBe(true)
  })

  it('sub-agent 不再阻止 unknown moderate（与主 Agent 一致）', () => {
    expect(isSubAgentBlocked(assessment('moderate', true))).toBe(false)
  })
})
