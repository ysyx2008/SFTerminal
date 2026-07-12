/**
 * 用户「始终允许」持久化清单单元测试
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

import {
  UserAllowlist,
  resetUserAllowlistForTest,
  clearUserAllowlistTestState,
} from '../user-allowlist'
import { buildAllowlistKey } from '../key'

describe('UserAllowlist', () => {
  const tmpDir = path.join(os.tmpdir(), `sft-allowlist-${Date.now()}`)
  const storePath = path.join(tmpDir, 'agent-allowlist.json')
  let allowlist: UserAllowlist

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    allowlist = resetUserAllowlistForTest(storePath)
  })

  afterEach(() => {
    clearUserAllowlistTestState()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('add + load 持久化', async () => {
    const key = buildAllowlistKey('exec', { command: 'npm test' })
    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'npm test' },
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })

    const reloaded = resetUserAllowlistForTest(storePath)
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].key).toBe(key)
  })

  it('风险未升级时 check 返回 allow', async () => {
    const key = buildAllowlistKey('exec', { command: 'echo hi' })
    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'echo hi' },
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    const r = await allowlist.check(key, () => 'moderate')
    expect(r.hit).toBe(true)
    expect(r.action).toBe('allow')
  })

  it('风险升级时 check 返回 reconfirm', async () => {
    const key = buildAllowlistKey('exec', { command: 'curl x' })
    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'curl x' },
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    const r = await allowlist.check(key, () => 'dangerous')
    expect(r.action).toBe('reconfirm')
  })

  it('变为 blocked 时 check 返回 block 并删除条目', async () => {
    const key = buildAllowlistKey('exec', { command: 'rm -rf /' })
    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'rm -rf /' },
      riskLevelAtApproval: 'dangerous',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    const r = await allowlist.check(key, () => 'blocked')
    expect(r.action).toBe('block')
    expect(allowlist.list()).toHaveLength(0)
  })

  it('remove 与 clear', async () => {
    const key = buildAllowlistKey('exec', { command: 'ls' })
    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'ls' },
      riskLevelAtApproval: 'safe',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    await allowlist.remove(key)
    expect(allowlist.list()).toHaveLength(0)

    await allowlist.add({
      key,
      toolName: 'exec',
      keyArgs: { command: 'ls' },
      riskLevelAtApproval: 'safe',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    await allowlist.clear()
    expect(allowlist.list()).toHaveLength(0)
  })

  it('remove 通过兄弟键也能清掉另一工具名的条目', async () => {
    const cmd = { command: 'git status' }
    const execKey = buildAllowlistKey('exec', cmd)
    const runKey = buildAllowlistKey('execute_command', cmd)
    await allowlist.add({
      key: execKey,
      toolName: 'exec',
      keyArgs: cmd,
      riskLevelAtApproval: 'moderate',
      approvedAt: Date.now(),
      sourceAgentKey: 'tab-1',
      sourceKind: 'task',
    })
    expect(allowlist.list()).toHaveLength(1)
    // 用另一工具名的键删除，应清掉已存的 exec 条目
    await allowlist.remove(runKey)
    expect(allowlist.list()).toHaveLength(0)
  })
})
