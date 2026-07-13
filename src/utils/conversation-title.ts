/**
 * 会话侧栏展示标题：优先 record.title，否则回退 userTask。
 * 标题是会话自身字段，不再走 config overlay。
 */
export function resolveConversationDisplayTitle(record: {
  title?: string
  userTask: string
}): string {
  const raw = record.title?.trim() || record.userTask.trim()
  return raw.replace(/\s+/g, ' ')
}
