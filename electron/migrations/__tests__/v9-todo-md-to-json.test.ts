import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'SailFish', getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: class {},
}))

import { prepareTodoMdMigration } from '../v9-todo-md-to-json'
import {
  getTodoMigrationMarkerPath,
  readTodoMigrationMarker,
  relocateLegacyTodoMigrationMarker,
} from '../../services/agent/skills/todo/migration-marker'

describe('migration v9 - prepareTodoMdMigration', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v9-todo-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips when no TODO.md', () => {
    const r = prepareTodoMdMigration(tmpDir)
    expect(r.status).toBe('skipped')
  })

  it('backs up and marks pending when TODO.md has content', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'TODO.md'), '- [ ] 交周报\n- [ ] 续费', 'utf-8')

    const r = prepareTodoMdMigration(tmpDir)
    expect(r.status).toBe('pending')
    expect(fs.existsSync(path.join(ws, 'TODO.md.bak'))).toBe(true)
    expect(fs.existsSync(path.join(ws, 'TODO.md'))).toBe(true)

    const markerPath = getTodoMigrationMarkerPath(tmpDir)
    expect(markerPath.replace(/\\/g, '/')).toContain('/migrations/todo-md.json')
    const marker = readTodoMigrationMarker(markerPath)
    expect(marker?.status).toBe('pending')
  })

  it('is idempotent when already pending', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'TODO.md'), '- [ ] a', 'utf-8')
    prepareTodoMdMigration(tmpDir)
    const r2 = prepareTodoMdMigration(tmpDir)
    expect(r2.status).toBe('already_pending')
  })

  it('marks done when TODO.json already has items', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'TODO.md'), '- [ ] old', 'utf-8')
    fs.writeFileSync(
      path.join(ws, 'TODO.json'),
      JSON.stringify({
        version: 1,
        todos: [{ id: '1', title: 'x', status: 'pending', createdAt: 't', updatedAt: 't' }],
        updatedAt: Date.now(),
      }),
      'utf-8'
    )
    const r = prepareTodoMdMigration(tmpDir)
    expect(r.status).toBe('already_done')
    expect(readTodoMigrationMarker(getTodoMigrationMarkerPath(tmpDir))?.status).toBe('done')
  })

  it('relocates root TODO.migration.json into migrations/', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(
      path.join(ws, 'TODO.migration.json'),
      JSON.stringify({ version: 1, status: 'deferred', createdAt: 1 }),
      'utf-8',
    )
    relocateLegacyTodoMigrationMarker(tmpDir)
    const next = getTodoMigrationMarkerPath(tmpDir)
    expect(fs.existsSync(next)).toBe(true)
    expect(fs.existsSync(path.join(ws, 'TODO.migration.json'))).toBe(false)
    expect(readTodoMigrationMarker(next)?.status).toBe('deferred')
  })
})
