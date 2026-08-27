import type { KnowledgeDocument } from './types'

export function conversationSessionTag(sessionId: string): string {
  return `session:${sessionId}`
}

/** 一条知识库文档是否属于指定会话的对话检索条目（对不上的旧条目不会命中） */
export function isConversationDocForSession(
  doc: Pick<KnowledgeDocument, 'fileType' | 'contentHash' | 'tags'>,
  sessionId: string,
  sessionContentHash: string
): boolean {
  if (doc.fileType !== 'conversation') return false
  if (sessionContentHash && doc.contentHash === sessionContentHash) return true
  return doc.tags.includes(conversationSessionTag(sessionId))
}
