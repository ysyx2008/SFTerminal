/**
 * 待办交办文案：只搬运原文，不说教。
 */
import type { TodoItem, TodoJournalEntry, TodoSource } from '@sailfish/shared-types'

export type TodoHandoffKind = 'handle' | 'schedule'

export interface TodoHandoffOptions {
  minutes?: number
  locale?: string
}

function isZh(locale?: string): boolean {
  return !locale || locale.toLowerCase().startsWith('zh')
}

function formatSource(source: TodoSource, zh: boolean): string {
  const bits: string[] = []
  if (source.label) bits.push(source.label)
  switch (source.kind) {
    case 'conversation':
      bits.push(zh ? '对话' : 'conversation')
      if (source.sessionId) bits.push(`sessionId=${source.sessionId}`)
      if (source.agentKey) bits.push(`agentKey=${source.agentKey}`)
      break
    case 'email':
      bits.push(zh ? '邮件' : 'email')
      if (source.messageId) bits.push(`messageId=${source.messageId}`)
      if (source.from) bits.push(`${zh ? '发件人' : 'from'}=${source.from}`)
      if (source.subject) bits.push(`${zh ? '主题' : 'subject'}=${source.subject}`)
      break
    case 'file':
      bits.push(zh ? '文件' : 'file')
      if (source.path) bits.push(source.path)
      break
    case 'url':
      bits.push(zh ? '网页' : 'url')
      if (source.url) bits.push(source.url)
      break
  }
  return `- ${bits.join(' · ')}`
}

function formatJournal(entry: TodoJournalEntry, zh: boolean): string {
  if (entry.kind === 'scheduled') {
    const range = [entry.start, entry.end].filter(Boolean).join(' – ')
    const cal = [entry.calendarId, entry.eventId].filter(Boolean).join('/')
    const extra = cal ? ` (${cal})` : ''
    return `- ${zh ? '已安排' : 'scheduled'} ${range}${extra}`
  }
  return `- ${zh ? '进展' : 'progress'} ${entry.note ?? ''}`
}

function formatTodoBody(item: TodoItem, zh: boolean): string {
  const lines = [
    `${zh ? '标题' : 'title'}: ${item.title}`,
    `id: ${item.id}`,
    `${zh ? '状态' : 'status'}: ${item.status}`,
  ]
  if (item.priority) lines.push(`${zh ? '优先级' : 'priority'}: ${item.priority}`)
  if (item.dueDate) lines.push(`${zh ? '截止' : 'due'}: ${item.dueDate}`)
  if (item.tags?.length) lines.push(`${zh ? '标签' : 'tags'}: ${item.tags.join(', ')}`)
  if (item.description) {
    lines.push(`${zh ? '备注' : 'notes'}:`)
    lines.push(item.description)
  }
  if (item.sources?.length) {
    lines.push(`${zh ? '出处' : 'sources'}:`)
    for (const source of item.sources) lines.push(formatSource(source, zh))
  }
  if (item.journal?.length) {
    lines.push(`${zh ? '事项日志' : 'journal'}:`)
    for (const entry of item.journal) lines.push(formatJournal(entry, zh))
  }
  return lines.join('\n')
}

export function buildTodoHandoffPrompt(
  item: TodoItem,
  kind: TodoHandoffKind,
  options: TodoHandoffOptions = {}
): string {
  const zh = isZh(options.locale)
  const body = formatTodoBody(item, zh)

  if (kind === 'schedule') {
    const minutes = options.minutes && options.minutes > 0 ? options.minutes : undefined
    const duration = minutes
      ? (zh ? `时长 ${minutes} 分钟。` : `Duration: ${minutes} minutes.`)
      : ''
    const intent = zh
      ? `帮我给下面这条待办分配时间。${duration}`
      : `Help me schedule time for this todo. ${duration}`
    return `${intent.trim()}\n\n${body}`
  }

  const intent = zh ? '帮我办下面这条待办。' : 'Help me handle this todo.'
  return `${intent}\n\n${body}`
}
