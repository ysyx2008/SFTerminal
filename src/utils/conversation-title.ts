/**
 * 会话侧栏展示标题：优先 record.title，否则回退 userTask。
 * 标题是会话自身字段，不再走 config overlay。
 */
import i18n from '../i18n'

export function resolveConversationDisplayTitle(record: {
  title?: string
  userTask: string
}): string {
  const titled = record.title?.trim()
  if (titled) return titled.replace(/\s+/g, ' ')

  const task = record.userTask.trim()
  if (task === '__onboarding__') {
    return String(i18n.global.t('ai.onboardingConversationTitle'))
  }
  return task.replace(/\s+/g, ' ')
}
