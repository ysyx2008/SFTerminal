/**
 * PowerShell 官方 AST 审计测试（仅 Windows）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-pwsh-audit-${Date.now()}`)
const isWin = process.platform === 'win32'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ensureAgentWorkspaceDirs, getScratchPath } from '../../tools/file'
import { assessCommandRisk, assessCommandRiskDetailed } from '../../risk-assessor'
import { ensurePwshAstReady } from '../extract-pwsh-calls'

describe.skipIf(!isWin)('assessCommandRisk PowerShell AST', () => {
  beforeEach(async () => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    await ensurePwshAstReady()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('Remove-Item scratch 文件 → safe（路径分区降级）', async () => {
    const scratch = getScratchPath()
    const target = path.join(scratch, 'test_comprehensive.ps1')
    const cmd = `Remove-Item "${target}" -Force`
    const d = await assessCommandRiskDetailed(cmd, { cwd: scratch })
    expect(d.parsed).toBe(true)
    expect(d.level).toBe('safe')
    expect(d.calls.some(c => c.reasons.some(r => r.includes('Remove-Item') || r.includes('remove-item')))).toBe(true)
  })

  it('Get-Content 只读 → safe', async () => {
    const scratch = getScratchPath()
    const target = path.join(scratch, 'readme.txt')
    expect(await assessCommandRisk(`Get-Content "${target}"`, { cwd: scratch })).toBe('safe')
  })

  it('Remove-Item -Recurse C:\\ → blocked', async () => {
    expect(await assessCommandRisk('Remove-Item -Recurse -Force C:\\')).toBe('blocked')
  })

  it('管道多命令聚合最高风险', async () => {
    const scratch = getScratchPath()
    const target = path.join(scratch, 'a.txt')
    const cmd = `Get-Content "${target}"; Remove-Item "${target}" -Force`
    const d = await assessCommandRiskDetailed(cmd, { cwd: scratch })
    expect(d.parsed).toBe(true)
    expect(d.level).toBe('safe')
    expect(d.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('Invoke-Expression → dangerous（间接执行）', async () => {
    expect(await assessCommandRisk('Invoke-Expression "Remove-Item C:\\\\ -Recurse"')).toBe('dangerous')
  })
})
