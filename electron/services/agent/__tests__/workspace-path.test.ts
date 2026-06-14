/**
 * agent-workspace 路径分层单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-workspace-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  getWorkspacePath,
  getScratchPath,
  ensureAgentWorkspaceDirs,
  isInWorkspace,
  isScratchPath,
  isProtectedWorkspacePath,
  isAutoApproveWorkspacePath,
} from '../tools/file'

describe('agent workspace paths', () => {
  beforeEach(() => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('getScratchPath creates scratch under workspace', () => {
    const scratch = getScratchPath()
    expect(scratch).toBe(path.join(getWorkspacePath(), 'scratch'))
    expect(fs.existsSync(scratch)).toBe(true)
  })

  it('isProtectedWorkspacePath blocks IDENTITY/SOUL at root only', () => {
    const ws = getWorkspacePath()
    expect(isProtectedWorkspacePath(path.join(ws, 'SOUL.md'))).toBe(true)
    expect(isProtectedWorkspacePath(path.join(ws, 'IDENTITY.md'))).toBe(true)
    expect(isProtectedWorkspacePath(path.join(ws, 'USER.md'))).toBe(false)
    expect(isProtectedWorkspacePath(path.join(ws, 'HEARTBEAT.md'))).toBe(false)
    expect(isProtectedWorkspacePath(path.join(ws, 'TODO.md'))).toBe(false)
    expect(isProtectedWorkspacePath(path.join(ws, 'scratch', 'SOUL.md'))).toBe(false)
  })

  it('isAutoApproveWorkspacePath allows scratch, TODO, USER, charts', () => {
    const ws = getWorkspacePath()
    const scratch = getScratchPath()
    expect(isAutoApproveWorkspacePath(path.join(scratch, 'draft.py'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'TODO.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'USER.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'HEARTBEAT.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'CONTACTS.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'charts', 'pie-1.svg'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'templates', 'report.docx'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'SOUL.md'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'random.py'))).toBe(false)
  })

  it('isScratchPath is narrower than isInWorkspace', () => {
    const ws = getWorkspacePath()
    expect(isInWorkspace(path.join(ws, 'TODO.md'))).toBe(true)
    expect(isScratchPath(path.join(ws, 'TODO.md'))).toBe(false)
    expect(isScratchPath(path.join(getScratchPath(), 'a.txt'))).toBe(true)
  })
})
