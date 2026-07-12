/**
 * 用户命令规则单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'sft-user-cmd-rules-mock-userdata')
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  resetUserCommandRulesForTest,
  clearUserCommandRulesTestState,
  lookupUserCommandRule,
} from '../user-command-rules'
import { getArgvCommandRule } from '../resolve-argv-rule'
import type { RiskLevel } from '@shared/types/agent'

describe('UserCommandRules', () => {
  const tmpDir = path.join(os.tmpdir(), `sft-user-cmd-rules-${Date.now()}`)
  const storePath = path.join(tmpDir, 'agent-command-rules.json')

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    resetUserCommandRulesForTest(storePath)
  })

  afterEach(() => {
    clearUserCommandRulesTestState()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upsert + lookup 持久化', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({
      cmd: 'mycli',
      baseLevel: 'safe',
      writesTo: false,
      safeFlags: '-n -i --color',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rule.cmd).toBe('mycli')
    expect(r.rule.safeFlags).toEqual(['--color', '-i', '-n'])

    const reloaded = resetUserCommandRulesForTest(storePath)
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(lookupUserCommandRule('mycli')?.baseLevel).toBe('safe')
    expect(getArgvCommandRule('mycli')?.baseLevel).toBe('safe')
    expect(getArgvCommandRule('/usr/local/bin/mycli')?.writesTo).toBe(false)
  })

  it('拒绝覆盖内置命令', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({ cmd: 'rm', baseLevel: 'safe', writesTo: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('builtin_conflict')
    // 内置仍生效
    expect(getArgvCommandRule('rm')?.baseLevel).toBe('dangerous')
  })

  it('拒绝 blocked 等级', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({ cmd: 'mytool', baseLevel: 'blocked' as RiskLevel, writesTo: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_level')
  })

  it('内置优先于用户规则同名（即使文件被篡改）', async () => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      rules: [{ cmd: 'ls', baseLevel: 'dangerous', writesTo: true, pathMode: 'all', safeFlags: [] }],
    }))
    resetUserCommandRulesForTest(storePath)
    // sanitize 丢弃与内置冲突的条目
    expect(lookupUserCommandRule('ls')).toBeUndefined()
    expect(getArgvCommandRule('ls')?.baseLevel).toBe('safe')
  })

  it('remove 删除规则后回到未知', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    await store.upsert({ cmd: 'fd', baseLevel: 'safe', writesTo: false })
    expect(getArgvCommandRule('fd')).toBeTruthy()
    await store.remove('fd')
    expect(getArgvCommandRule('fd')).toBeUndefined()
  })
})
