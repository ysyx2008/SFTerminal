import { describe, expect, it } from 'vitest'
import {
  conversationSessionTag,
  isConversationDocForSession,
} from '../conversation-index'

describe('isConversationDocForSession', () => {
  const sessionId = 'session_123'
  const sessionHash = 'hash-of-conv-session_123'
  const sessionTag = conversationSessionTag(sessionId)

  it('matches conversation docs tagged with the session', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-run-xyz',
      tags: ['conversation', 'personal', sessionTag],
    }, sessionId, sessionHash)).toBe(true)
  })

  it('matches backfill-style docs keyed by session id', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: sessionHash,
      tags: ['conversation', 'personal'],
    }, sessionId, sessionHash)).toBe(true)
  })

  it('does not match host memory or uploaded docs', () => {
    expect(isConversationDocForSession({
      fileType: 'host-memory',
      contentHash: sessionHash,
      tags: ['host-memory', sessionTag],
    }, sessionId, sessionHash)).toBe(false)
    expect(isConversationDocForSession({
      fileType: 'pdf',
      contentHash: sessionHash,
      tags: ['conversation', sessionTag],
    }, sessionId, sessionHash)).toBe(false)
  })

  it('does not match other conversations or untagged old entries', () => {
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-other',
      tags: ['conversation', 'personal', conversationSessionTag('session_other')],
    }, sessionId, sessionHash)).toBe(false)
    expect(isConversationDocForSession({
      fileType: 'conversation',
      contentHash: 'hash-of-conv-run-old',
      tags: ['conversation', 'personal'],
    }, sessionId, sessionHash)).toBe(false)
  })
})
