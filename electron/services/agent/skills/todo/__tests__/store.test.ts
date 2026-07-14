import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-todo-store-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  applyTodoUpdate,
  createTodoItem,
  emptyStore,
  getTodoStorePath,
  hasLegacyTodoMd,
  loadStore,
  normalizeStore,
  resetWriteQueueForTest,
  saveStore,
} from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

describe('todo store', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('loadStore returns empty when file missing', () => {
    const store = loadStore()
    expect(store.version).toBe(1)
    expect(store.todos).toEqual([])
  })

  it('saveStore then loadStore roundtrips', async () => {
    const item = createTodoItem({ title: '写周报', dueDate: '2026-07-20', priority: 'high' })
    const store = emptyStore()
    store.todos.push(item)
    await saveStore(store)

    expect(fs.existsSync(getTodoStorePath())).toBe(true)
    const loaded = loadStore()
    expect(loaded.todos).toHaveLength(1)
    expect(loaded.todos[0].title).toBe('写周报')
    expect(loaded.todos[0].priority).toBe('high')
    expect(loaded.todos[0].createdAt).toBeTruthy()
  })

  it('normalizeStore recovers bad status and missing ids', () => {
    const normalized = normalizeStore({
      todos: [
        { title: 'a', status: 'bogus' },
        { id: 'x', title: '  ', status: 'pending' },
        { id: 'ok', title: 'b', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
    expect(normalized.todos).toHaveLength(2)
    expect(normalized.todos[0].status).toBe('pending')
    expect(normalized.todos[0].id).toBeTruthy()
    expect(normalized.todos[1].completedAt).toBeTruthy()
  })

  it('bad JSON falls back to empty store', () => {
    fs.writeFileSync(getTodoStorePath(), '{not-json', 'utf-8')
    const store = loadStore()
    expect(store.todos).toEqual([])
  })

  it('applyTodoUpdate sets and clears completedAt', () => {
    const item = createTodoItem({ title: 't' })
    const done = applyTodoUpdate(item, { status: 'completed' })
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBeTruthy()
    const reopen = applyTodoUpdate(done, { status: 'pending' })
    expect(reopen.status).toBe('pending')
    expect(reopen.completedAt).toBeUndefined()
  })

  it('hasLegacyTodoMd detects TODO.md', () => {
    expect(hasLegacyTodoMd()).toBe(false)
    fs.writeFileSync(path.join(mockUserData, 'agent-workspace', 'TODO.md'), '- [ ] old', 'utf-8')
    expect(hasLegacyTodoMd()).toBe(true)
  })

  it('serializes concurrent saves', async () => {
    const a = emptyStore()
    a.todos.push(createTodoItem({ title: 'one' }))
    const b = emptyStore()
    b.todos.push(createTodoItem({ title: 'two' }))
    b.todos.push(createTodoItem({ title: 'three' }))
    await Promise.all([saveStore(a), saveStore(b)])
    const loaded = loadStore()
    expect(loaded.todos.length).toBeGreaterThanOrEqual(1)
    expect(loaded.todos.every(t => t.title)).toBe(true)
  })
})
