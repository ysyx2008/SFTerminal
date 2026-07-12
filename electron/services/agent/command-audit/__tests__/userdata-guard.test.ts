/**
 * userData 访问守卫测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-userdata-guard-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  isUserDataForbidden,
  setUserDataGuardForTest,
  resetUserDataGuardForTest,
} from '../userdata-guard'
import { isSystemPath } from '../workspace-guard'
import { ensureAgentWorkspaceDirs, getScratchPath } from '../../tools/file'
import { assessCommandRisk } from '../../risk-assessor'

describe('userdata-guard', () => {
  beforeEach(() => {
    fs.mkdirSync(mockUserData, { recursive: true })
    setUserDataGuardForTest(mockUserData)
    ensureAgentWorkspaceDirs()
  })

  afterEach(() => {
    resetUserDataGuardForTest()
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('历史 agent-allowlist.json 在 userData 下应 forbidden', () => {
    const p = path.join(mockUserData, 'agent-allowlist.json')
    expect(isUserDataForbidden(p)).toBe(true)
    expect(isSystemPath(p)).toBe(true)
  })

  it('agent-command-rules.json 在 userData 下应 forbidden', () => {
    const p = path.join(mockUserData, 'agent-command-rules.json')
    expect(isUserDataForbidden(p)).toBe(true)
  })

  it('credentials.json 应 forbidden', () => {
    const p = path.join(mockUserData, 'credentials.json')
    expect(isUserDataForbidden(p)).toBe(true)
  })

  it('agent-workspace/scratch 应允许', () => {
    const scratch = getScratchPath()
    fs.writeFileSync(path.join(scratch, 'x.txt'), 'ok')
    expect(isUserDataForbidden(path.join(scratch, 'x.txt'))).toBe(false)
  })

  it('agent-workspace/templates 应允许', () => {
    const templates = path.join(mockUserData, 'agent-workspace', 'templates')
    fs.mkdirSync(templates, { recursive: true })
    const p = path.join(templates, 'x.md')
    expect(isUserDataForbidden(p)).toBe(false)
  })

  it('userData 外路径不拦截', () => {
    expect(isUserDataForbidden('/tmp/outside.txt')).toBe(false)
  })
})

describe('assessCommandRisk userData forbidden paths', () => {
  beforeEach(async () => {
    fs.mkdirSync(mockUserData, { recursive: true })
    setUserDataGuardForTest(mockUserData)
    ensureAgentWorkspaceDirs()
    const { ensureShellAstReady } = await import('../parser')
    await ensureShellAstReady()
  })

  afterEach(() => {
    resetUserDataGuardForTest()
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('cat 历史 agent-allowlist.json 应为 blocked', async () => {
    const target = path.join(mockUserData, 'agent-allowlist.json')
    const level = await assessCommandRisk(`cat "${target}"`)
    expect(level).toBe('blocked')
  })

  it('rm credentials.json 应为 blocked', async () => {
    const target = path.join(mockUserData, 'credentials.json')
    const level = await assessCommandRisk(`rm "${target}"`)
    expect(level).toBe('blocked')
  })
})
