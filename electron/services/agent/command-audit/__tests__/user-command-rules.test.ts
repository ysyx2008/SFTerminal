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
import { assessCommandRisk } from '../../risk-assessor'

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

  it('拒绝放松内置命令', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({ cmd: 'rm', baseLevel: 'safe', writesTo: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('builtin_conflict')
    expect(getArgvCommandRule('rm')?.baseLevel).toBe('dangerous')
  })

  it('未收录命令可标硬拒', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({ cmd: 'mytool', baseLevel: 'blocked', writesTo: false })
    expect(r.ok).toBe(true)
    expect(getArgvCommandRule('mytool')?.baseLevel).toBe('blocked')
  })

  it('内置命令可升成硬拒，去掉规则后回到内置档', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const r = await store.upsert({ cmd: 'rm', baseLevel: 'blocked', writesTo: true })
    expect(r.ok).toBe(true)
    expect(getArgvCommandRule('rm')?.baseLevel).toBe('blocked')
    await store.remove('rm')
    expect(getArgvCommandRule('rm')?.baseLevel).toBe('dangerous')
  })

  it('篡改文件放松内置档会被丢掉；升成硬拒会保留', async () => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      rules: [{ cmd: 'ls', baseLevel: 'dangerous', writesTo: true, pathMode: 'all', safeFlags: [] }],
    }))
    resetUserCommandRulesForTest(storePath)
    expect(lookupUserCommandRule('ls')).toBeUndefined()
    expect(getArgvCommandRule('ls')?.baseLevel).toBe('safe')

    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      rules: [{ cmd: 'ls', baseLevel: 'blocked', writesTo: false, pathMode: 'none', safeFlags: [] }],
    }))
    resetUserCommandRulesForTest(storePath)
    expect(getArgvCommandRule('ls')?.baseLevel).toBe('blocked')
  })

  it('升成硬拒后该命令一律 blocked，不受路径降级', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    await store.upsert({ cmd: 'rm', baseLevel: 'blocked', writesTo: true })
    expect(await assessCommandRisk('rm file.txt')).toBe('blocked')
  })

  it('硬拒不被间接执行或动态路径降级', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    const free = { executionMode: 'free' as const }
    await store.upsert({ cmd: 'python3', baseLevel: 'blocked' })
    expect(await assessCommandRisk('python3 -c "print(1)"', free)).toBe('blocked')
    await store.upsert({ cmd: 'rm', baseLevel: 'blocked', writesTo: true })
    expect(await assessCommandRisk('rm $FOO', free)).toBe('blocked')
  })

  it('remove 删除规则后回到未知', async () => {
    const store = resetUserCommandRulesForTest(storePath)
    await store.upsert({ cmd: 'fd', baseLevel: 'safe', writesTo: false })
    expect(getArgvCommandRule('fd')).toBeTruthy()
    await store.remove('fd')
    expect(getArgvCommandRule('fd')).toBeUndefined()
  })
})
