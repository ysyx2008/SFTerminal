import { describe, expect, it } from 'vitest'
import {
  deriveTabAgentUiMeta,
  formatAgentAttentionTooltip,
  formatHistoryConversationTooltip,
} from '../agent-tab-ui-meta'

const t = (key: string) => key

describe('deriveTabAgentUiMeta', () => {
  it('returns open when agentState is undefined', () => {
    const meta = deriveTabAgentUiMeta(undefined)
    expect(meta).toEqual({
      status: 'open',
      pendingConfirm: false,
      agentCompletedUnseen: false,
      needsAttention: false,
      isRunning: false,
    })
  })

  it('returns open when idle', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: false })
    expect(meta.status).toBe('open')
    expect(meta.needsAttention).toBe(false)
  })

  it('returns running when busy without attention flags', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: true })
    expect(meta.status).toBe('running')
    expect(meta.needsAttention).toBe(false)
  })

  it('returns attention when pending confirm even if running', () => {
    const meta = deriveTabAgentUiMeta({
      isRunning: true,
      pendingConfirm: { toolCallId: 'x', toolName: 'exec', toolArgs: {}, riskLevel: 'dangerous' },
    })
    expect(meta.status).toBe('attention')
    expect(meta.needsAttention).toBe(true)
    expect(meta.pendingConfirm).toBe(true)
  })

  it('returns attention when task completed unseen', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: false, agentCompletedUnseen: true })
    expect(meta.status).toBe('attention')
    expect(meta.agentCompletedUnseen).toBe(true)
  })
})

describe('formatAgentAttentionTooltip', () => {
  it('returns undefined when no attention needed', () => {
    expect(formatAgentAttentionTooltip({ pendingConfirm: false, agentCompletedUnseen: false, needsAttention: false }, t)).toBeUndefined()
  })

  it('returns confirm key when pending confirm', () => {
    expect(formatAgentAttentionTooltip({ pendingConfirm: true, agentCompletedUnseen: false, needsAttention: true }, t)).toBe('tabs.needsAttentionConfirm')
  })
})

describe('formatHistoryConversationTooltip', () => {
  it('returns running label for running status', () => {
    expect(formatHistoryConversationTooltip({ status: 'running', pendingConfirm: false, agentCompletedUnseen: false }, t))
      .toBe('welcome.conversations.agentRunning')
  })
})
