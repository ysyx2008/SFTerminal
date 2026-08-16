import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-todo-api-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  addTodoSource,
  appendTodoJournal,
  completeTodo,
  countOverdueTodos,
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from '../api'
import { onTodoStoreChanged, resetWriteQueueForTest } from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

describe('todo api', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('create + list + complete + delete', async () => {
    const item = await createTodo({ title: '面板待办', dueDate: '2099-01-01' })
    expect(item.id).toBeTruthy()
    expect(listTodos()).toHaveLength(1)

    const done = await completeTodo(item.id)
    expect(done?.status).toBe('completed')
    expect(listTodos()).toHaveLength(0)
    expect(listTodos({ includeDone: true })).toHaveLength(1)

    expect(await deleteTodo(item.id)).toBe(true)
    expect(listTodos({ includeDone: true })).toHaveLength(0)
  })

  it('countOverdueTodos counts only active past-due', async () => {
    await createTodo({ title: '逾期', dueDate: '2020-01-01T00:00:00.000Z' })
    await createTodo({ title: '未来', dueDate: '2099-01-01T00:00:00.000Z' })
    expect(countOverdueTodos()).toBe(1)
  })

  it('saveStore notifies listeners', async () => {
    const spy = vi.fn()
    const off = onTodoStoreChanged(spy)
    await createTodo({ title: 'notify' })
    expect(spy).toHaveBeenCalled()
    off()
  })

  it('concurrent creates do not drop items', async () => {
    await Promise.all([
      createTodo({ title: 'a' }),
      createTodo({ title: 'b' }),
      createTodo({ title: 'c' }),
    ])
    expect(listTodos()).toHaveLength(3)
  })

  it('appendJournal and addSource persist without dropping history', async () => {
    const item = await createTodo({
      title: '带出处',
      sources: [{ kind: 'conversation', sessionId: 'sess-a' }],
    })
    expect(item.sources).toHaveLength(1)

    const withLog = await appendTodoJournal(item.id, {
      kind: 'scheduled',
      start: '2026-08-18T14:00:00.000Z',
      end: '2026-08-18T15:00:00.000Z',
    })
    expect(withLog?.journal).toHaveLength(1)

    const withProgress = await appendTodoJournal(item.id, {
      kind: 'progress',
      note: '草稿已写',
    })
    expect(withProgress?.journal).toHaveLength(2)
    expect(withProgress?.sources).toHaveLength(1)

    const dup = await addTodoSource(item.id, { kind: 'conversation', sessionId: 'sess-a' })
    expect(dup?.sources).toHaveLength(1)

    const extra = await addTodoSource(item.id, { kind: 'file', path: '/tmp/a.md' })
    expect(extra?.sources).toHaveLength(2)
  })

  it('updateTodo can reopen completed', async () => {
    const item = await createTodo({ title: 'x' })
    await completeTodo(item.id)
    const reopened = await updateTodo(item.id, { status: 'pending' })
    expect(reopened?.status).toBe('pending')
    expect(reopened?.completedAt).toBeUndefined()
  })
})
