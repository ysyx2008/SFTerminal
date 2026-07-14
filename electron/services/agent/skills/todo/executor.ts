/**
 * 本地秘书待办技能 - 执行器
 */
import type { TodoItem, TodoPriority, TodoStatus } from '@sailfish/shared-types'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import {
  applyTodoUpdate,
  createTodoItem,
  hasLegacyTodoMd,
  LEGACY_TODO_MD_HINT,
  loadStore,
  saveStore,
} from './store'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TodoExecutor')

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

function withLegacyHint(output: string): string {
  if (!hasLegacyTodoMd()) return output
  return `${output}\n\n${LEGACY_TODO_MD_HINT}`
}

function formatItem(item: TodoItem): string {
  const parts = [
    `- **${item.title}** [\`${item.id}\`]`,
    `  status: ${item.status}`,
  ]
  if (item.priority) parts.push(`  priority: ${item.priority}`)
  if (item.dueDate) parts.push(`  due: ${item.dueDate}`)
  parts.push(`  created: ${item.createdAt}`)
  parts.push(`  updated: ${item.updatedAt}`)
  if (item.completedAt) parts.push(`  completed: ${item.completedAt}`)
  if (item.description) parts.push(`  desc: ${item.description}`)
  if (item.tags?.length) parts.push(`  tags: ${item.tags.join(', ')}`)
  return parts.join('\n')
}

async function todoList(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const store = loadStore()
  let items = [...store.todos]

  const status = args.status as string | undefined
  const includeDone = args.include_done === true || status === 'all'

  if (status && status !== 'all') {
    items = items.filter(t => t.status === status)
  } else if (!includeDone) {
    items = items.filter(t => t.status === 'pending' || t.status === 'in_progress')
  }

  if (typeof args.priority === 'string' && args.priority) {
    items = items.filter(t => t.priority === args.priority)
  }
  if (typeof args.due_before === 'string' && args.due_before) {
    items = items.filter(t => t.dueDate && t.dueDate <= args.due_before)
  }
  if (typeof args.due_after === 'string' && args.due_after) {
    items = items.filter(t => t.dueDate && t.dueDate >= args.due_after)
  }
  if (typeof args.tag === 'string' && args.tag) {
    items = items.filter(t => t.tags?.includes(args.tag as string))
  }

  const sortBy = (args.sort_by as string) || 'due'
  const sortOrder = (args.sort_order as string) === 'desc' ? -1 : 1
  items.sort((a, b) => {
    let cmp = 0
    switch (sortBy) {
      case 'created':
        cmp = a.createdAt.localeCompare(b.createdAt)
        break
      case 'updated':
        cmp = a.updatedAt.localeCompare(b.updatedAt)
        break
      case 'priority': {
        const ra = a.priority ? PRIORITY_RANK[a.priority] : 99
        const rb = b.priority ? PRIORITY_RANK[b.priority] : 99
        cmp = ra - rb
        break
      }
      case 'due':
      default: {
        if (a.dueDate && b.dueDate) cmp = a.dueDate.localeCompare(b.dueDate)
        else if (a.dueDate) cmp = -1
        else if (b.dueDate) cmp = 1
        else cmp = a.createdAt.localeCompare(b.createdAt)
        break
      }
    }
    return cmp * sortOrder
  })

  executor.addStep({
    type: 'tool_call',
    content: `列出本地待办 (${items.length})`,
    toolName: 'todo_list',
    toolArgs: args,
    riskLevel: 'safe',
  })

  const body =
    items.length === 0
      ? '（无匹配待办）'
      : items.map(formatItem).join('\n\n')
  const output = withLegacyHint(`## 本地待办 (${items.length})\n\n${body}`)

  executor.addStep({
    type: 'tool_result',
    content: `本地待办 ${items.length} 条`,
    toolName: 'todo_list',
    toolResult: output,
  })

  return { success: true, output }
}

async function todoCreate(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) {
    return { success: false, output: '', error: 'title is required' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `创建待办: ${title}`,
    toolName: 'todo_create',
    toolArgs: { title },
    riskLevel: 'safe',
  })

  const item = createTodoItem({
    title,
    description: typeof args.description === 'string' ? args.description : undefined,
    priority: args.priority as TodoPriority | undefined,
    dueDate: typeof args.due_date === 'string' ? args.due_date : undefined,
    tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
    status: args.status as TodoStatus | undefined,
  })

  const store = loadStore()
  store.todos.push(item)
  await saveStore(store)

  const output = withLegacyHint(`已创建待办：${item.title}\nID: ${item.id}\ncreatedAt: ${item.createdAt}`)
  executor.addStep({
    type: 'tool_result',
    content: `已创建: ${item.title}`,
    toolName: 'todo_create',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoUpdate(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  const store = loadStore()
  const idx = store.todos.findIndex(t => t.id === id)
  if (idx < 0) return { success: false, output: '', error: `Todo not found: ${id}` }

  executor.addStep({
    type: 'tool_call',
    content: `更新待办: ${store.todos[idx].title}`,
    toolName: 'todo_update',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  const patch: Parameters<typeof applyTodoUpdate>[1] = {}
  if (typeof args.title === 'string') patch.title = args.title
  if (args.clear_description === true) patch.description = null
  else if (typeof args.description === 'string') {
    patch.description = args.description === '' ? null : args.description
  }
  const notes: string[] = []
  if (args.clear_priority === true || args.priority === '') {
    patch.priority = null
  } else if (typeof args.priority === 'string') {
    const p = args.priority as TodoPriority
    if (['low', 'normal', 'high', 'urgent'].includes(p)) patch.priority = p
    else notes.push(`ignored invalid priority: ${args.priority}`)
  }
  if (args.clear_due_date === true || args.due_date === '') patch.dueDate = null
  else if (typeof args.due_date === 'string') patch.dueDate = args.due_date
  if (args.clear_tags === true) patch.tags = null
  else if (Array.isArray(args.tags)) patch.tags = args.tags as string[]
  if (typeof args.status === 'string') {
    const s = args.status as TodoStatus
    if (['pending', 'in_progress', 'completed', 'cancelled'].includes(s)) patch.status = s
    else notes.push(`ignored invalid status: ${args.status}`)
  }

  const updated = applyTodoUpdate(store.todos[idx], patch)
  store.todos[idx] = updated
  await saveStore(store)

  let output = `已更新待办：\n${formatItem(updated)}`
  if (notes.length) output += `\n\n备注：${notes.join('; ')}`
  output = withLegacyHint(output)
  executor.addStep({
    type: 'tool_result',
    content: `已更新: ${updated.title}`,
    toolName: 'todo_update',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoComplete(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  const store = loadStore()
  const idx = store.todos.findIndex(t => t.id === id)
  if (idx < 0) return { success: false, output: '', error: `Todo not found: ${id}` }

  executor.addStep({
    type: 'tool_call',
    content: `完成待办: ${store.todos[idx].title}`,
    toolName: 'todo_complete',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  const updated = applyTodoUpdate(store.todos[idx], { status: 'completed' })
  store.todos[idx] = updated
  await saveStore(store)

  const output = withLegacyHint(`已完成待办：${updated.title} (${id})`)
  executor.addStep({
    type: 'tool_result',
    content: `已完成: ${updated.title}`,
    toolName: 'todo_complete',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoDelete(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  const store = loadStore()
  const idx = store.todos.findIndex(t => t.id === id)
  if (idx < 0) return { success: false, output: '', error: `Todo not found: ${id}` }

  const removed = store.todos[idx]
  executor.addStep({
    type: 'tool_call',
    content: `删除待办: ${removed.title}`,
    toolName: 'todo_delete',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  store.todos.splice(idx, 1)
  await saveStore(store)

  const output = withLegacyHint(`已删除待办：${removed.title} (${id})`)
  executor.addStep({
    type: 'tool_result',
    content: `已删除: ${removed.title}`,
    toolName: 'todo_delete',
    toolResult: output,
  })
  return { success: true, output }
}

/**
 * 执行本地 todo 技能工具
 */
export async function executeTodoTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'todo_list':
        return await todoList(args, executor)
      case 'todo_create':
        return await todoCreate(args, executor)
      case 'todo_update':
        return await todoUpdate(args, executor)
      case 'todo_complete':
        return await todoComplete(args, executor)
      case 'todo_delete':
        return await todoDelete(args, executor)
      default:
        return { success: false, output: '', error: `Unknown todo tool: ${toolName}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error(`todo tool failed: ${toolName}`, e)
    return { success: false, output: '', error: msg }
  }
}
