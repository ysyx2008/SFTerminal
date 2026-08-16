/**
 * 本地待办服务（TodoService）
 * 路径：{userData}/agent-workspace/TODO.json
 *
 * 主进程完整门面：读写 / CRUD / 事件。IPC 与 JSON 仍使用 plain TodoItem。
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type {
  TodoItem,
  TodoJournalEntry,
  TodoJournalKind,
  TodoPriority,
  TodoSource,
  TodoSourceKind,
  TodoStatus,
  TodoStoreData,
} from '@sailfish/shared-types'
import { getWorkspacePath } from '../../tools/file'
import { createLogger } from '../../../../utils/logger'
import { LEGACY_TODO_MD, TODO_FILENAME } from './migration-marker'

export { LEGACY_TODO_MD, TODO_FILENAME } from './migration-marker'

const log = createLogger('TodoService')

export const LEGACY_TODO_MD_HINT =
  '注意：工作空间仍有旧版 TODO.md。请用 read_file 阅读后，用 todo_create 逐条写入结构化待办；勿用 shell 删改 TODO.md（备份由程序处理）。迁完后把 migrations/todo-md.json 写成 status=done（该目录免确认）。'

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']
const VALID_PRIORITIES: TodoPriority[] = ['low', 'normal', 'high', 'urgent']
const VALID_JOURNAL_KINDS: TodoJournalKind[] = ['scheduled', 'progress']
const VALID_SOURCE_KINDS: TodoSourceKind[] = ['conversation', 'email', 'file', 'url']

export type TodoJournalInput = Omit<TodoJournalEntry, 'id' | 'at'>
export type TodoSourceInput = Omit<TodoSource, 'id' | 'at'>

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export type TodoChangeListener = () => void

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
  sources?: TodoSourceInput[]
}

export type TodoUpdatePatch = {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: TodoPriority | null
  dueDate?: string | null
  tags?: string[] | null
}

/**
 * 待办领域门面：落盘 + 列表筛选 + CRUD + 变更通知。
 * 单例见 getTodoService()。
 */
export class TodoService {
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly changeListeners = new Set<TodoChangeListener>()

  /** 注册 TODO.json 写入成功后的监听（IPC 广播 / 测试用） */
  onChanged(listener: TodoChangeListener): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch (e) {
        log.warn('Todo service change listener failed:', e)
      }
    }
  }

  getPath(): string {
    return path.join(getWorkspacePath(), TODO_FILENAME)
  }

  getLegacyTodoMdPath(): string {
    return path.join(getWorkspacePath(), LEGACY_TODO_MD)
  }

  hasLegacyTodoMd(): boolean {
    try {
      return fs.existsSync(this.getLegacyTodoMdPath())
    } catch {
      return false
    }
  }

  emptyStore(): TodoStoreData {
    return { version: 1, todos: [], updatedAt: Date.now() }
  }

  normalizeStore(raw: unknown): TodoStoreData {
    if (!raw || typeof raw !== 'object') return this.emptyStore()
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
      const journal = normalizeJournalList(t.journal)
      if (journal) todo.journal = journal
      const sources = normalizeSourceList(t.sources)
      if (sources) todo.sources = sources
      todos.push(todo)
    }

    return {
      version: 1,
      todos,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    }
  }

  /** 读 TODO.json；不存在或坏 JSON → 空 store（不抛错） */
  load(): TodoStoreData {
    const filePath = this.getPath()
    try {
      if (!fs.existsSync(filePath)) return this.emptyStore()
      const raw = fs.readFileSync(filePath, 'utf-8')
      if (!raw.trim()) return this.emptyStore()
      return this.normalizeStore(JSON.parse(raw))
    } catch (e) {
      log.warn('Failed to load TODO.json, falling back to empty store:', e)
      return this.emptyStore()
    }
  }

  /** 原子写入（.tmp + rename），进程内串行化 */
  async save(store: TodoStoreData): Promise<void> {
    const next = this.writeQueue.then(() => this.writeSync(store))
    this.writeQueue = next.catch((err) => {
      log.warn('TODO.json write failed in queue:', err)
    })
    await next
  }

  /**
   * 在写队列内原子读-改-写，避免 Agent 工具与面板 IPC 并发丢条目。
   * 通知在 rename 成功后、save/mutate Promise resolve 前发出（文件已落地）。
   */
  async mutate<T>(mutator: (store: TodoStoreData) => T): Promise<T> {
    const next = this.writeQueue.then(() => {
      const store = this.load()
      const result = mutator(store)
      this.writeSync(store)
      return result
    })
    this.writeQueue = next.then(
      () => undefined,
      (err) => {
        log.warn('TODO.json mutate failed in queue:', err)
      }
    )
    return next
  }

  private writeSync(store: TodoStoreData): void {
    const workspace = getWorkspacePath()
    fs.mkdirSync(workspace, { recursive: true })
    const filePath = this.getPath()
    const tmpPath = `${filePath}.${process.pid}.tmp`
    const payload: TodoStoreData = {
      version: 1,
      todos: store.todos,
      updatedAt: Date.now(),
    }
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
    this.notifyChanged()
  }

  createItem(input: {
    title: string
    description?: string
    status?: TodoStatus
    priority?: TodoPriority
    dueDate?: string
    tags?: string[]
    sources?: TodoSourceInput[]
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
    const sources = stampSources(input.sources, now)
    if (sources) item.sources = sources
    return item
  }

  applyUpdate(
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

  private sortTodos(items: TodoItem[]): TodoItem[] {
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

    done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return [...active, ...done]
  }

  list(filter: TodoListFilter = {}): TodoItem[] {
    let items = [...this.load().todos]
    const { status, includeDone } = filter

    if (status && status !== 'all') {
      items = items.filter(t => t.status === status)
    } else if (!includeDone) {
      items = items.filter(t => t.status === 'pending' || t.status === 'in_progress')
    }

    return this.sortTodos(items)
  }

  /** 未完成且 dueDate 早于当前时刻的条数（Tab 逾期提示） */
  countOverdue(now = new Date()): number {
    const iso = now.toISOString()
    return this.load().todos.filter(
      t =>
        (t.status === 'pending' || t.status === 'in_progress') &&
        !!t.dueDate &&
        t.dueDate < iso
    ).length
  }

  async create(input: TodoCreateInput): Promise<TodoItem> {
    const title = input.title?.trim()
    if (!title) throw new Error('title is required')

    const item = this.createItem({
      title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate,
      tags: input.tags,
      sources: input.sources,
    })
    await this.mutate(store => {
      store.todos.push(item)
    })
    return item
  }

  async update(id: string, patch: TodoUpdatePatch): Promise<TodoItem | null> {
    if (!id) throw new Error('id is required')
    return this.mutate(store => {
      const idx = store.todos.findIndex(t => t.id === id)
      if (idx < 0) return null
      const updated = this.applyUpdate(store.todos[idx], patch)
      store.todos[idx] = updated
      return updated
    })
  }

  async complete(id: string): Promise<TodoItem | null> {
    return this.update(id, { status: 'completed' })
  }

  async delete(id: string): Promise<boolean> {
    if (!id) throw new Error('id is required')
    return this.mutate(store => {
      const before = store.todos.length
      store.todos = store.todos.filter(t => t.id !== id)
      return store.todos.length < before
    })
  }

  async appendJournal(id: string, input: TodoJournalInput): Promise<TodoItem | null> {
    if (!id) throw new Error('id is required')
    const entry = stampJournal(input)
    if (!entry) return null
    if (!this.load().todos.some(t => t.id === id)) return null
    return this.mutate(store => {
      const idx = store.todos.findIndex(t => t.id === id)
      if (idx < 0) return null
      const item = store.todos[idx]
      const journal = [...(item.journal ?? []), entry]
      const next: TodoItem = { ...item, journal, updatedAt: new Date().toISOString() }
      store.todos[idx] = next
      return next
    })
  }

  async addSource(id: string, input: TodoSourceInput): Promise<TodoItem | null> {
    if (!id) throw new Error('id is required')
    const source = stampSource(input)
    if (!source) return null
    if (!this.load().todos.some(t => t.id === id)) return null
    return this.mutate(store => {
      const idx = store.todos.findIndex(t => t.id === id)
      if (idx < 0) return null
      const item = store.todos[idx]
      const existing = item.sources ?? []
      const key = sourceLocatorKey(source)
      if (key && existing.some(s => sourceLocatorKey(s) === key)) {
        return item
      }
      const sources = [...existing, source]
      const next: TodoItem = { ...item, sources, updatedAt: new Date().toISOString() }
      store.todos[idx] = next
      return next
    })
  }

  /** 测试用：清空写队列（vitest） */
  resetWriteQueueForTest(): void {
    this.writeQueue = Promise.resolve()
  }
}

// —— 单例 ——

let instance: TodoService | null = null

export function getTodoService(): TodoService {
  if (!instance) instance = new TodoService()
  return instance
}

/** @internal 测试用：重置单例 */
export function resetTodoServiceForTest(): void {
  instance = null
}

// —— 兼容导出（委托单例，调用方可不改 import） ——

export function onTodoStoreChanged(listener: TodoChangeListener): () => void {
  return getTodoService().onChanged(listener)
}

export function getTodoStorePath(): string {
  return getTodoService().getPath()
}

export function getLegacyTodoMdPath(): string {
  return getTodoService().getLegacyTodoMdPath()
}

export function hasLegacyTodoMd(): boolean {
  return getTodoService().hasLegacyTodoMd()
}

export function emptyStore(): TodoStoreData {
  return getTodoService().emptyStore()
}

export function normalizeStore(raw: unknown): TodoStoreData {
  return getTodoService().normalizeStore(raw)
}

export function loadStore(): TodoStoreData {
  return getTodoService().load()
}

export async function saveStore(store: TodoStoreData): Promise<void> {
  return getTodoService().save(store)
}

export async function mutateStore<T>(mutator: (store: TodoStoreData) => T): Promise<T> {
  return getTodoService().mutate(mutator)
}

export function createTodoItem(input: {
  title: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  dueDate?: string
  tags?: string[]
  sources?: TodoSourceInput[]
}): TodoItem {
  return getTodoService().createItem(input)
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
  return getTodoService().applyUpdate(item, patch)
}

export function resetWriteQueueForTest(): void {
  getTodoService().resetWriteQueueForTest()
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function sourceHasLocator(source: Pick<TodoSource, 'kind' | 'sessionId' | 'messageId' | 'path' | 'url' | 'subject' | 'from'>): boolean {
  switch (source.kind) {
    case 'conversation':
      return !!source.sessionId
    case 'email':
      return !!(source.messageId || source.subject || source.from)
    case 'file':
      return !!source.path
    case 'url':
      return !!source.url
    default:
      return false
  }
}

/** 仅在定位字段足够唯一时去重；email 无 messageId 不去重（同主题两封不该互挤） */
function sourceLocatorKey(source: Pick<TodoSource, 'kind' | 'sessionId' | 'messageId' | 'path' | 'url'>): string | null {
  switch (source.kind) {
    case 'conversation':
      return source.sessionId ? `conversation:${source.sessionId}` : null
    case 'email':
      return source.messageId ? `email:${source.messageId}` : null
    case 'file':
      return source.path ? `file:${source.path}` : null
    case 'url':
      return source.url ? `url:${source.url}` : null
    default:
      return null
  }
}

function stampJournal(raw: TodoJournalInput, at = new Date().toISOString()): TodoJournalEntry | null {
  if (!VALID_JOURNAL_KINDS.includes(raw.kind)) return null
  const start = optionalString(raw.start)
  const note = optionalString(raw.note)
  if (raw.kind === 'scheduled' && !start) return null
  if (raw.kind === 'progress' && !note) return null
  const entry: TodoJournalEntry = {
    id: randomUUID(),
    kind: raw.kind,
    at,
  }
  if (start) entry.start = start
  const end = optionalString(raw.end)
  if (end) entry.end = end
  const calendarId = optionalString(raw.calendarId)
  if (calendarId) entry.calendarId = calendarId
  const eventId = optionalString(raw.eventId)
  if (eventId) entry.eventId = eventId
  if (note) entry.note = note
  const sessionId = optionalString(raw.sessionId)
  if (sessionId) entry.sessionId = sessionId
  return entry
}

function stampSource(raw: TodoSourceInput, at = new Date().toISOString()): TodoSource | null {
  if (!VALID_SOURCE_KINDS.includes(raw.kind)) return null
  const source: TodoSource = {
    id: randomUUID(),
    kind: raw.kind,
    at,
  }
  const label = optionalString(raw.label)
  if (label) source.label = label
  const sessionId = optionalString(raw.sessionId)
  if (sessionId) source.sessionId = sessionId
  const agentKey = optionalString(raw.agentKey)
  if (agentKey) source.agentKey = agentKey
  const messageId = optionalString(raw.messageId)
  if (messageId) source.messageId = messageId
  const subject = optionalString(raw.subject)
  if (subject) source.subject = subject
  const from = optionalString(raw.from)
  if (from) source.from = from
  const filePath = optionalString(raw.path)
  if (filePath) source.path = filePath
  const url = optionalString(raw.url)
  if (url) source.url = url
  if (!sourceHasLocator(source)) return null
  return source
}

function stampSources(raw: TodoSourceInput[] | undefined, at: string): TodoSource[] | undefined {
  if (!raw?.length) return undefined
  const seen = new Set<string>()
  const sources: TodoSource[] = []
  for (const item of raw) {
    const source = stampSource(item, at)
    if (!source) continue
    const key = sourceLocatorKey(source)
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    sources.push(source)
  }
  return sources.length ? sources : undefined
}

function normalizeJournalList(raw: unknown): TodoJournalEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list: TodoJournalEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const kind = t.kind as TodoJournalKind
    const stamped = stampJournal({
      kind,
      start: optionalString(t.start),
      end: optionalString(t.end),
      calendarId: optionalString(t.calendarId),
      eventId: optionalString(t.eventId),
      note: optionalString(t.note),
      sessionId: optionalString(t.sessionId),
    }, optionalString(t.at) || new Date().toISOString())
    if (!stamped) continue
    if (typeof t.id === 'string' && t.id) stamped.id = t.id
    list.push(stamped)
  }
  return list.length ? list : undefined
}

function normalizeSourceList(raw: unknown): TodoSource[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const list: TodoSource[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const stamped = stampSource({
      kind: t.kind as TodoSourceKind,
      label: optionalString(t.label),
      sessionId: optionalString(t.sessionId),
      agentKey: optionalString(t.agentKey),
      messageId: optionalString(t.messageId),
      subject: optionalString(t.subject),
      from: optionalString(t.from),
      path: optionalString(t.path),
      url: optionalString(t.url),
    }, optionalString(t.at) || new Date().toISOString())
    if (!stamped) continue
    if (typeof t.id === 'string' && t.id) stamped.id = t.id
    const key = sourceLocatorKey(stamped)
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    list.push(stamped)
  }
  return list.length ? list : undefined
}
