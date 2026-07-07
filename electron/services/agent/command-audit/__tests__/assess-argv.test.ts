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

  // ── indirection guard：解释器内联 / 包装器 / 调度器（命中标 dangerous，free 放行）──

  it('node -e is dangerous (interpreter inline code)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'node', args: ['-e', "require('fs').unlinkSync('/')"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('node --eval is dangerous', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'node', args: ['--eval', "process.exit(1)"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('python -c is dangerous (interpreter inline code)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'python3', args: ['-c', "import os; os.remove('/')"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('bash -c is dangerous (shell wrapper)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'bash', args: ['-c', 'ls -la'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('zsh -c is dangerous (shell wrapper)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'zsh', args: ['-c', 'ls -la /Users/'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('/bin/zsh -c is dangerous (absolute path shell)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: '/bin/zsh', args: ['-c', 'ls'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('perl -e is dangerous', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'perl', args: ['-e', "unlink '/'"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('ruby -e is dangerous', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'ruby', args: ['-e', "File.delete('/')"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('php -r is dangerous', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'php', args: ['-r', "unlink('/');"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('lua -e is dangerous', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'lua', args: ['-e', "os.remove('/')"], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('sh -c is dangerous (posix shell wrapper)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'sh', args: ['-c', 'ls -la'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  // ── 包装器 / 调度器 ──

  it('sudo rm is dangerous (wrapper)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'sudo', args: ['rm', '-f', '/etc/passwd'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('env bash -c is dangerous (wrapper, original bypass)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'env', args: ['bash', '-c', 'rm -rf /'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('docker run is dangerous (orchestrator)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'docker', args: ['run', 'alpine', 'rm', '-rf', '/'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('npx is dangerous (orchestrator)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'npx', args: ['some-package'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  // ── 结构性 flag 规则 ──

  it('find -exec is dangerous (structural flag)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'find', args: [scratch, '-name', '*.log', '-exec', 'rm', '{}', ';'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('find -delete is dangerous (structural flag)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'find', args: [scratch, '-name', '*.tmp', '-delete'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  it('find with safe flags stays safe (no -exec/-delete)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'find', args: [scratch, '-name', '*.log', '-print'], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('tar --to-command is dangerous (structural flag)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'tar', args: ['--to-command=rm', '-xf', 'archive.tar'], cwd: scratch })
    expect(r.level).toBe('dangerous')
  })

  // ── 合法用途不受影响 ──

  it('node script.js is NOT dangerous (runs script file, not inline)', () => {
    const scratch = getScratchPath()
    const script = path.join(scratch, 'build.js')
    fs.writeFileSync(script, 'console.log("ok")')
    const r = assessArgvRisk({ cmd: 'node', args: [script], cwd: scratch })
    // 不应 dangerous；node 是 safe，script 在 scratch（free zone）→ safe
    expect(r.level).not.toBe('dangerous')
  })

  it('python3 -m http.server is NOT dangerous (module mode, not inline)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'python3', args: ['-m', 'http.server', '8000'], cwd: scratch })
    expect(r.level).not.toBe('dangerous')
  })

  it('git -c core.x=y status is NOT dangerous (-c is config, not exec)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'git', args: ['-c', 'core.something=value', 'status'], cwd: scratch })
    expect(r.level).not.toBe('dangerous')
  })

  it('git status stays safe (normal direct command)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'git', args: ['status'], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('ls with safe flags stays safe (regression: guard does not over-block Direct)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'ls', args: ['-la', scratch], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('ls -lart stays safe (regression: 5-char combined flag not over-blocked)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'ls', args: ['-lart', scratch], cwd: scratch })
    expect(r.level).toBe('safe')
  })

  it('git --exec-path is NOT dangerous (regression: --exec substring false positive)', () => {
    const scratch = getScratchPath()
    const r = assessArgvRisk({ cmd: 'git', args: ['--exec-path'], cwd: scratch })
    expect(r.level).not.toBe('dangerous')
  })
})
