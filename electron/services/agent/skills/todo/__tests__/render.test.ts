import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-todo-render-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { renderTodosForContext } from '../render'
import type { TodoStoreData } from '@sailfish/shared-types'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

describe('renderTodosForContext', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('returns empty string when no active todos', () => {
    const store: TodoStoreData = {
      version: 1,
      updatedAt: Date.now(),
      todos: [
        {
          id: '1',
          title: 'done',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }
    expect(renderTodosForContext({ store, includeLegacyHint: false })).toBe('')
  })

  it('renders status priority due and created', () => {
    const store: TodoStoreData = {
      version: 1,
      updatedAt: Date.now(),
      todos: [
        {
          id: '1',
          title: '交周报',
          status: 'pending',
          priority: 'urgent',
          dueDate: '2026-07-18',
          createdAt: '2026-07-10T08:00:00.000Z',
          updatedAt: '2026-07-10T08:00:00.000Z',
        },
      ],
    }
    const text = renderTodosForContext({ store, includeLegacyHint: false })
    expect(text).toContain('# 待办事项')
    expect(text).toContain('[pending|urgent] 交周报')
    expect(text).toContain('截止: 2026-07-18')
    expect(text).toContain('创建: 2026-07-10T08:00:00.000Z')
  })

  it('hints legacy TODO.md when json empty', () => {
    fs.writeFileSync(
      path.join(mockUserData, 'agent-workspace', 'TODO.md'),
      '- [ ] old item',
      'utf-8'
    )
    const text = renderTodosForContext({
      store: { version: 1, todos: [], updatedAt: Date.now() },
    })
    expect(text).toContain('未迁移的 TODO.md')
  })

  it('truncates over maxChars', () => {
    const todos = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      title: `任务${i}`.repeat(20),
      status: 'pending' as const,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }))
    const text = renderTodosForContext({
      store: { version: 1, todos, updatedAt: Date.now() },
      maxChars: 200,
      includeLegacyHint: false,
    })
    expect(text.length).toBeLessThanOrEqual(220)
    expect(text).toContain('完整列表请 todo_list')
  })
})
