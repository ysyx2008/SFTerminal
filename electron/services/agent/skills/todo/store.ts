/**
 * 本地待办 JSON store
 * 路径：{userData}/agent-workspace/TODO.json
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { TodoItem, TodoPriority, TodoStatus, TodoStoreData } from '@sailfish/shared-types'
import { getWorkspacePath } from '../../tools/file'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TodoStore')

export const TODO_FILENAME = 'TODO.json'
export const LEGACY_TODO_MD = 'TODO.md'

export const LEGACY_TODO_MD_HINT =
  '注意：工作空间仍有旧版 TODO.md。请用 read_file 阅读后，用 todo_create 逐条写入结构化待办；完成后将 TODO.md 重命名为 TODO.md.bak。'

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const VALID_PRIORITIES: TodoPriority[] = ['low', 'normal', 'high', 'urgent']

let writeQueue: Promise<void> = Promise.resolve()

export function getTodoStorePath(): string {
  return path.join(getWorkspacePath(), TODO_FILENAME)
}

export function getLegacyTodoMdPath(): string {
  return path.join(getWorkspacePath(), LEGACY_TODO_MD)
}

export function hasLegacyTodoMd(): boolean {
  try {
    return fs.existsSync(getLegacyTodoMdPath())
  } catch {
    return false
  }
}

export function emptyStore(): TodoStoreData {
  return { version: 1, todos: [], updatedAt: Date.now() }
}

export function normalizeStore(raw: unknown): TodoStoreData {
  if (!raw || typeof raw !== 'object') return emptyStore()
  const obj = raw as Record<string, unknown>
  const todosRaw = Array.isArray(obj.todos) ? obj.todos : []
  const todos: TodoItem[] = []

  for (const item of todosRaw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const title = typeof t.title === 'string' ? t.title.trim() : ''
    if (!title) continue

    const now = new Date().toISOString()
    const status = VALID_STATUSES.includes(t.status as TodoStatus)
      ? (t.status as TodoStatus)
      : 'pending'
    const priority = VALID_PRIORITIES.includes(t.priority as TodoPriority)
      ? (t.priority as TodoPriority)
      : undefined

    const createdAt = typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : now
    const updatedAt = typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : createdAt

    const todo: TodoItem = {
      id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
      title,
      status,
      createdAt,
      updatedAt,
    }
    if (typeof t.description === 'string' && t.description) todo.description = t.description
    if (priority) todo.priority = priority
    if (typeof t.dueDate === 'string' && t.dueDate) todo.dueDate = t.dueDate
    if (status === 'completed') {
      todo.completedAt =
        typeof t.completedAt === 'string' && t.completedAt ? t.completedAt : updatedAt
    }
    if (Array.isArray(t.tags)) {
      const tags = t.tags.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      if (tags.length > 0) todo.tags = tags
    }
    todos.push(todo)
  }

  return {
    version: 1,
    todos,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
  }
}

/**
 * 读 TODO.json；不存在或坏 JSON → 空 store（不抛错）
 */
export function loadStore(): TodoStoreData {
  const filePath = getTodoStorePath()
  try {
    if (!fs.existsSync(filePath)) return emptyStore()
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw.trim()) return emptyStore()
    return normalizeStore(JSON.parse(raw))
  } catch (e) {
    log.warn('Failed to load TODO.json, falling back to empty store:', e)
    return emptyStore()
  }
}

/**
 * 原子写入（.tmp + rename），进程内串行化
 */
export async function saveStore(store: TodoStoreData): Promise<void> {
  const next = writeQueue.then(() => writeStoreSync(store))
  // 保持队列不永久卡死；错误仍通过 await next 向上抛给调用方
  writeQueue = next.catch((err) => {
    log.warn('TODO.json write failed in queue:', err)
  })
  await next
}

function writeStoreSync(store: TodoStoreData): void {
  const workspace = getWorkspacePath()
  fs.mkdirSync(workspace, { recursive: true })
  const filePath = getTodoStorePath()
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const payload: TodoStoreData = {
    version: 1,
    todos: store.todos,
    updatedAt: Date.now(),
  }
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export function createTodoItem(input: {
  title: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  dueDate?: string
  tags?: string[]
}): TodoItem {
  const now = new Date().toISOString()
  const status = input.status && VALID_STATUSES.includes(input.status) ? input.status : 'pending'
  const item: TodoItem = {
    id: randomUUID(),
    title: input.title.trim(),
    status,
    createdAt: now,
    updatedAt: now,
  }
  if (input.description?.trim()) item.description = input.description.trim()
  if (input.priority && VALID_PRIORITIES.includes(input.priority)) item.priority = input.priority
  if (input.dueDate?.trim()) item.dueDate = input.dueDate.trim()
  if (input.tags?.length) {
    item.tags = input.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
  }
  if (status === 'completed') item.completedAt = now
  return item
}

export function applyTodoUpdate(
  item: TodoItem,
  patch: {
    title?: string
    description?: string | null
    status?: TodoStatus
    priority?: TodoPriority | null
    dueDate?: string | null
    tags?: string[] | null
  }
): TodoItem {
  const next: TodoItem = { ...item }
  if (typeof patch.title === 'string' && patch.title.trim()) {
    next.title = patch.title.trim()
  }
  if (patch.description === null) {
    delete next.description
  } else if (typeof patch.description === 'string') {
    next.description = patch.description.trim() || undefined
    if (!next.description) delete next.description
  }
  if (patch.priority === null) {
    delete next.priority
  } else if (patch.priority && VALID_PRIORITIES.includes(patch.priority)) {
    next.priority = patch.priority
  }
  if (patch.dueDate === null) {
    delete next.dueDate
  } else if (typeof patch.dueDate === 'string') {
    const d = patch.dueDate.trim()
    if (d) next.dueDate = d
    else delete next.dueDate
  }
  if (patch.tags === null) {
    delete next.tags
  } else if (Array.isArray(patch.tags)) {
    const tags = patch.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
    if (tags.length > 0) next.tags = tags
    else delete next.tags
  }
  if (patch.status && VALID_STATUSES.includes(patch.status)) {
    const prev = next.status
    next.status = patch.status
    if (patch.status === 'completed' && prev !== 'completed') {
      next.completedAt = new Date().toISOString()
    } else if (patch.status !== 'completed') {
      delete next.completedAt
    }
  }
  next.updatedAt = new Date().toISOString()
  return next
}

/** 测试用：清空写队列（vitest） */
export function resetWriteQueueForTest(): void {
  writeQueue = Promise.resolve()
}
