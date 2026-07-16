/**
 * 本地待办 UI / IPC API —— 与 Agent todo_* 工具共用 store，不经 executor
 */
import type { TodoItem, TodoPriority, TodoStatus } from '@sailfish/shared-types'
import { applyTodoUpdate, createTodoItem, loadStore, mutateStore } from './store'

export interface TodoListFilter {
  /** 精确状态；`all` = 全部；缺省且未设 includeDone = 仅 pending/in_progress */
  status?: TodoStatus | 'all'
  includeDone?: boolean
}

export interface TodoCreateInput {
  title: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  dueDate?: string
  tags?: string[]
}

export type TodoUpdatePatch = {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: TodoPriority | null
  dueDate?: string | null
  tags?: string[] | null
}

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

function sortTodos(items: TodoItem[]): TodoItem[] {
  const isDone = (t: TodoItem) => t.status === 'completed' || t.status === 'cancelled'
  const active = items.filter(t => !isDone(t))
  const done = items.filter(isDone)

  active.sort((a, b) => {
    if (a.dueDate && b.dueDate) {
      const cmp = a.dueDate.localeCompare(b.dueDate)
      if (cmp !== 0) return cmp
    } else if (a.dueDate) return -1
    else if (b.dueDate) return 1

    const ra = a.priority ? PRIORITY_RANK[a.priority] : 99
    const rb = b.priority ? PRIORITY_RANK[b.priority] : 99
    if (ra !== rb) return ra - rb
    return a.createdAt.localeCompare(b.createdAt)
  })

  // 已完成/取消：按最后更新时间逆序
  done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return [...active, ...done]
}

export function listTodos(filter: TodoListFilter = {}): TodoItem[] {
  let items = [...loadStore().todos]
  const { status, includeDone } = filter

  if (status && status !== 'all') {
    items = items.filter(t => t.status === status)
  } else if (!includeDone) {
    items = items.filter(t => t.status === 'pending' || t.status === 'in_progress')
  }

  return sortTodos(items)
}

/** 未完成且 dueDate 早于当前时刻的条数（Tab 逾期提示） */
export function countOverdueTodos(now = new Date()): number {
  const iso = now.toISOString()
  return loadStore().todos.filter(
    t =>
      (t.status === 'pending' || t.status === 'in_progress') &&
      !!t.dueDate &&
      t.dueDate < iso
  ).length
}

export async function createTodo(input: TodoCreateInput): Promise<TodoItem> {
  const title = input.title?.trim()
  if (!title) throw new Error('title is required')

  const item = createTodoItem({
    title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    dueDate: input.dueDate,
    tags: input.tags,
  })
  await mutateStore(store => {
    store.todos.push(item)
  })
  return item
}

export async function updateTodo(id: string, patch: TodoUpdatePatch): Promise<TodoItem | null> {
  if (!id) throw new Error('id is required')
  return mutateStore(store => {
    const idx = store.todos.findIndex(t => t.id === id)
    if (idx < 0) return null
    const updated = applyTodoUpdate(store.todos[idx], patch)
    store.todos[idx] = updated
    return updated
  })
}

export async function completeTodo(id: string): Promise<TodoItem | null> {
  return updateTodo(id, { status: 'completed' })
}

export async function deleteTodo(id: string): Promise<boolean> {
  if (!id) throw new Error('id is required')
  return mutateStore(store => {
    const before = store.todos.length
    store.todos = store.todos.filter(t => t.id !== id)
    return store.todos.length < before
  })
}
