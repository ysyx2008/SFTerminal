/**
 * exec / execute_command 授权互通
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'sft-allowlist-mock-userdata')
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { checkPersistedAllowlist } from '../check-persisted'
import { buildAllowlistKey } from '../key'
import { resetUserAllowlistForTest, clearUserAllowlistTestState } from '../user-allowlist'

describe('checkPersistedAllowlist shell alias', () => {
  const tmpDir = path.join(os.tmpdir(), `sft-allowlist-alias-${Date.now()}`)
  const storePath = path.join(tmpDir, 'agent-allowlist.json')

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    resetUserAllowlistForTest(storePath)
  })

  afterEach(() => {
    clearUserAllowlistTestState()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('execute_command 写入后 exec 可命中', async () => {
    const allowlist = resetUserAllowlistForTest(storePath)
    const cmd = { command: 'git status' }
    await allowlist.add({
      key: buildAllowlistKey('execute_command', cmd),
      toolName: 'execute_command',
      keyArgs: cmd,
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: '__settings__',
      sourceKind: 'manual',
    })

    const r = await checkPersistedAllowlist('exec', cmd, () => 'moderate')
    expect(r.hit).toBe(true)
    expect(r.action).toBe('allow')
  })

  it('exec 写入后 execute_command 可命中', async () => {
    const allowlist = resetUserAllowlistForTest(storePath)
    const cmd = { command: 'ls -la' }
    await allowlist.add({
      key: buildAllowlistKey('exec', cmd),
      toolName: 'exec',
      keyArgs: cmd,
      riskLevelAtApproval: 'dangerous',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })

    const r = await checkPersistedAllowlist('execute_command', cmd, () => 'dangerous')
    expect(r.hit).toBe(true)
    expect(r.action).toBe('allow')
  })

  it('未授权时 miss', async () => {
    resetUserAllowlistForTest(storePath)
    const r = await checkPersistedAllowlist('exec', { command: 'whoami' }, () => 'safe')
    expect(r.hit).toBe(false)
    expect(r.key).toBe(buildAllowlistKey('exec', { command: 'whoami' }))
  })

  it('add 写入 canonical 时清掉兄弟键', async () => {
    const allowlist = resetUserAllowlistForTest(storePath)
    const cmd = { command: 'pwd' }
    await allowlist.add({
      key: buildAllowlistKey('exec', cmd),
      toolName: 'exec',
      keyArgs: cmd,
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    await allowlist.add({
      key: buildAllowlistKey('execute_command', cmd),
      toolName: 'execute_command',
      keyArgs: cmd,
      riskLevelAtApproval: 'dangerous',
      approvedAt: Date.now(),
      sourceAgentKey: '__settings__',
      sourceKind: 'manual',
    })
    expect(allowlist.list()).toHaveLength(1)
    expect(allowlist.list()[0].toolName).toBe('execute_command')

    const r = await checkPersistedAllowlist('exec', cmd, () => 'dangerous')
    expect(r.hit).toBe(true)
    expect(r.key).toBe(buildAllowlistKey('execute_command', cmd))
  })
})
