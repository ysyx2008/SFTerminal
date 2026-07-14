/**
 * 待办列表渲染（供 watch 心跳注入）
 * 只读 store，无技能注册副作用——watch 只应 import 本文件。
 */
import type { TodoItem, TodoStoreData } from '@sailfish/shared-types'
import { hasLegacyTodoMd, loadStore } from './store'

/** 与 watch.service WORKSPACE_FILE_MAX_CHARS 对齐 */
export const TODO_RENDER_MAX_CHARS = 8000

export interface RenderTodosOptions {
  /** 覆盖 store（测试用） */
  store?: TodoStoreData
  maxChars?: number
  /** 是否在空列表且存在旧 TODO.md 时注入迁移提示 */
  includeLegacyHint?: boolean
}

function formatTodoLine(item: TodoItem): string {
  const statusPart = item.priority ? `${item.status}|${item.priority}` : item.status
  let line = `- [${statusPart}] ${item.title}`
  const meta: string[] = []
  if (item.dueDate) meta.push(`截止: ${item.dueDate}`)
  meta.push(`创建: ${item.createdAt}`)
  if (item.tags?.length) meta.push(`标签: ${item.tags.join(',')}`)
  if (meta.length) line += ` (${meta.join(', ')})`
  return line
}

/**
 * 渲染待办为 AI 友好文本。
 * 无活跃待办且无迁移提示时返回 ''；有内容时带「# 待办事项」标题。
 */
export function renderTodosForContext(options?: RenderTodosOptions): string {
  const store = options?.store ?? loadStore()
  const maxChars = options?.maxChars ?? TODO_RENDER_MAX_CHARS
  const includeLegacyHint = options?.includeLegacyHint !== false

  const active = store.todos.filter(t => t.status === 'pending' || t.status === 'in_progress')
  // 按：有截止的在前（截止升序），无截止按创建时间升序
  active.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return a.createdAt.localeCompare(b.createdAt)
  })

  const lines: string[] = []
  if (active.length > 0) {
    lines.push('# 待办事项')
    for (const item of active) {
      lines.push(formatTodoLine(item))
    }
  }

  const legacyExists = includeLegacyHint && hasLegacyTodoMd()
  const jsonEmpty = store.todos.length === 0
  if (legacyExists && jsonEmpty) {
    if (lines.length === 0) {
      lines.push('# 待办事项')
    }
    lines.push('（存在未迁移的 TODO.md，请用 todo 技能迁移后再依赖此列表）')
  }

  if (lines.length === 0) return ''

  let text = lines.join('\n')
  if (text.length > maxChars) {
    const keep = Math.max(0, maxChars - 40)
    text = text.slice(0, keep).trimEnd() + '\n…（已截断，完整列表请 todo_list）'
  }
  return text
}
