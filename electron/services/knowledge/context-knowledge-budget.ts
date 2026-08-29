/** 单份记忆字数上限：默认、可设范围、读盘纠偏。与设置页同一份真相。 */

export const DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS = 5000
export const MIN_CONTEXT_KNOWLEDGE_MAX_CHARS = 1000
export const MAX_CONTEXT_KNOWLEDGE_MAX_CHARS = 20000

/** 读盘或输入不合法时回到默认五千字 */
export function clampContextKnowledgeMaxChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS
  }
  return Math.min(
    MAX_CONTEXT_KNOWLEDGE_MAX_CHARS,
    Math.max(MIN_CONTEXT_KNOWLEDGE_MAX_CHARS, Math.round(value))
  )
}
