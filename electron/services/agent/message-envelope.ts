/**
 * 用户消息与系统注入参考材料的结构化包裹标签。
 * 避免 LLM 将知识库召回、上下文提示误当作用户本次发言。
 */

export function wrapKnowledgeRefs(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return `<sf_knowledge_refs>\n${trimmed}\n</sf_knowledge_refs>`
}

export function wrapUserMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return `<sf_user_message>\n${trimmed}\n</sf_user_message>`
}

export function wrapSystemContext(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return `<sf_system_context>\n${trimmed}\n</sf_system_context>`
}

/** 组装发给 API 的 user 消息正文：参考材料在前，用户输入在后 */
export function assembleUserMessageContent(parts: {
  knowledgeRefs?: string
  systemContext?: string
  userMessage: string
  uploadedDocs?: string
  imageNote?: string
}): string {
  const blocks: string[] = []
  if (parts.knowledgeRefs?.trim()) blocks.push(parts.knowledgeRefs.trim())
  if (parts.systemContext?.trim()) blocks.push(parts.systemContext.trim())
  blocks.push(wrapUserMessage(parts.userMessage))
  if (parts.uploadedDocs?.trim()) blocks.push(parts.uploadedDocs.trim())
  // imageNote 是系统生成的附注（如"🖼️ 用户提供了 1 张图片"），不是用户发言，
  // 按纯文本追加，不能包进 <sf_user_message>
  if (parts.imageNote?.trim()) blocks.push(parts.imageNote.trim())
  return blocks.join('\n\n')
}
