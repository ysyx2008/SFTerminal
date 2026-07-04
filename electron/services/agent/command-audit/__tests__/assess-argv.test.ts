/**
 * command-audit argv 通道单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-cmd-audit-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs, getScratchPath, getWorkspacePath } from '../../tools/file'
import { assessArgvRisk } from '../assess-argv'
import { getWorkspaceZone } from '../workspace-guard'

describe('command-audit argv', () => {
  beforeEach(() => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('ls in scratch is safe', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'ls', args: ['-la', scratch], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('rm in scratch is safe (free zone)', () => {
    const scratch = getScratchPath()
    const target = path.join(scratch, 'draft.txt')
    const r = assessArgvRisk({ cmd: 'rm', args: ['-f', target], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('rm templates file is moderate (protected zone)', () => {
    const ws = getWorkspacePath()
    const templates = path.join(ws, 'templates')
    fs.mkdirSync(templates, { recursive: true })
    const target = path.join(templates, 'report.docx')
    fs.writeFileSync(target, 'x')
    const r = assessArgvRisk({ cmd: 'rm', args: ['-f', target], cwd: ws })
    expect(r.level).toBe('moderate')
  })

  it('rm /etc/passwd is blocked (system path)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'rm', args: ['-f', '/etc/passwd'], cwd: scratch })
    expect(r.level).toBe('blocked')
  })

  it('unknown command is moderate + hasUnknown (relaxed 需确认)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'mystery_tool', args: ['--foo'], cwd: scratch })
    expect(r.level).toBe('moderate')
    expect(r.hasUnknown).toBe(true)
  })

  it('cat outside workspace stays safe (read-only)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'cat', args: ['/etc/hosts'], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('rm outside workspace is dangerous', () => {
    const scratch = getScratchPath()
    const outside = path.join(os.tmpdir(), 'outside-delete-me.txt')
    const r = assessArgvRisk({ cmd: 'rm', args: ['-f', outside], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('getWorkspaceZone partitions correctly', () => {
    const ws = getWorkspacePath()
    const scratch = getScratchPath()
    expect(getWorkspaceZone(scratch, scratch)).toBe('free')
    expect(getWorkspaceZone(path.join(ws, 'charts', 'a.svg'), ws)).toBe('free')
    expect(getWorkspaceZone(path.join(ws, 'templates', 'x.docx'), ws)).toBe('protected')
    expect(getWorkspaceZone(path.join(ws, 'IDENTITY.md'), ws)).toBe('protected')
    expect(getWorkspaceZone(path.join(ws, 'random.py'), ws)).toBe('workspace')
    expect(getWorkspaceZone('/tmp/foo', scratch)).toBe('outside')
  })

  it('mixed outside + protected paths → dangerous (outside wins)', () => {
    const ws = getWorkspacePath()
    const templates = path.join(ws, 'templates', 'x.docx')
    const outside = path.join(os.tmpdir(), 'outside.txt')
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'rm', args: ['-f', outside, templates], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })
})
