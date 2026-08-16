import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolExecutorConfig } from '../../../tools/types'

const mockUserData = path.join(os.tmpdir(), `sft-todo-exec-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { executeTodoTool } from '../executor'
import { listTodos } from '../api'
import { resetWriteQueueForTest } from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

function mockExecutor(sessionId?: string): ToolExecutorConfig {
  return {
    agentId: 'agent-1',
    getSessionId: sessionId ? () => sessionId : undefined,
    addStep: () => ({ id: 's', timestamp: Date.now() }),
    updateStep: () => undefined,
  } as unknown as ToolExecutorConfig
}

describe('todo executor sources', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('todo_create records conversation source when session exists', async () => {
    const result = await executeTodoTool(
      'todo_create',
      '',
      { title: '从会话来' },
      'tc-1',
      {} as never,
      mockExecutor('sess-42')
    )
    expect(result.success).toBe(true)
    const items = listTodos()
    expect(items[0].sources?.[0]).toMatchObject({
      kind: 'conversation',
      sessionId: 'sess-42',
      agentKey: 'agent-1',
    })
  })

  it('todo_update appends journal and source', async () => {
    await executeTodoTool(
      'todo_create',
      '',
      { title: '可追加' },
      'tc-3',
      {} as never,
      mockExecutor()
    )
    const id = listTodos()[0].id
    const result = await executeTodoTool(
      'todo_update',
      '',
      {
        id,
        journal: { kind: 'progress', note: '草稿好了' },
        source: { kind: 'file', path: '/tmp/draft.md' },
      },
      'tu-1',
      {} as never,
      mockExecutor('sess-9')
    )
    expect(result.success).toBe(true)
    const item = listTodos()[0]
    expect(item.journal?.[0]).toMatchObject({ kind: 'progress', note: '草稿好了', sessionId: 'sess-9' })
    expect(item.sources?.[0]).toMatchObject({ kind: 'file', path: '/tmp/draft.md' })
  })

  it('todo_create has no source without session', async () => {
    await executeTodoTool(
      'todo_create',
      '',
      { title: '面板手敲' },
      'tc-2',
      {} as never,
      mockExecutor()
    )
    expect(listTodos()[0].sources).toBeUndefined()
  })
})
