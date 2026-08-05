/**
 * 用户消息与系统注入参考材料的结构化包裹标签。
 * 避免 LLM 将知识库召回、上下文提示误当作用户本次发言。
 */

import type { WorkbenchSelectionScope } from '@shared/types'

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

export function wrapSelectionScope(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  return `<sf_selection_scope>\n${trimmed}\n</sf_selection_scope>`
}

/** 将结构化选区作用域格式化为模型可读正文（再包进信封） */
export function formatSelectionScopeBody(scope: WorkbenchSelectionScope): string {
  const excerpt = scope.excerpt.trim()
  if (!excerpt) return ''
  const lines: string[] = [
    'The user selected the following excerpt as the edit scope. Edit only this range (anchor by content) unless they explicitly ask to expand the scope.',
  ]
  if (scope.sourcePath) {
    lines.push(`Path: ${scope.sourcePath}`)
  } else if (scope.label) {
    lines.push(`Label: ${scope.label}`)
  }
  if (scope.sourceLinesAccurate && scope.startLine != null && scope.endLine != null) {
    lines.push(`File lines: ${scope.startLine}-${scope.endLine}`)
  } else {
    lines.push('No exact file line numbers — anchor edits by the excerpt text.')
  }
  lines.push('', excerpt)
  return lines.join('\n')
}

/** 组装发给 API 的 user 消息正文：参考材料在前，用户输入在后 */
export function assembleUserMessageContent(parts: {
  knowledgeRefs?: string
  systemContext?: string
  /** 已包裹或未包裹均可；非空时放入选区信封槽 */
  selectionScope?: string
  userMessage: string
  uploadedDocs?: string
  imageNote?: string
}): string {
  const blocks: string[] = []
  if (parts.knowledgeRefs?.trim()) blocks.push(parts.knowledgeRefs.trim())
  if (parts.systemContext?.trim()) blocks.push(parts.systemContext.trim())
  if (parts.selectionScope?.trim()) {
    const raw = parts.selectionScope.trim()
    blocks.push(
      raw.startsWith('<sf_selection_scope>') ? raw : wrapSelectionScope(raw)
    )
  }
  blocks.push(wrapUserMessage(parts.userMessage))
  if (parts.uploadedDocs?.trim()) blocks.push(parts.uploadedDocs.trim())
  // imageNote 是系统生成的附注（如"🖼️ 用户提供了 1 张图片"），不是用户发言，
  // 按纯文本追加，不能包进 <sf_user_message>
  if (parts.imageNote?.trim()) blocks.push(parts.imageNote.trim())
  return blocks.join('\n\n')
}
