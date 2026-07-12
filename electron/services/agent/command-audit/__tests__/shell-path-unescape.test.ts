/**
 * shell 路径反斜杠转义 → 工作区分区正确识别
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return '/Users/yushen/Library/Application Support/SailFish'
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { unescapeShellWordLiteral } from '../unescape-shell-literal'
import { extractAuditedCalls } from '../extract-calls'
import { getWorkspaceZone } from '../workspace-guard'
import { assessShellRisk, defaultAuditContext } from '../assess-shell'

describe('unescapeShellWordLiteral', () => {
  it('解开 Application\\ Support', () => {
    expect(unescapeShellWordLiteral(String.raw`/Users/me/Library/Application\ Support/x`))
      .toBe('/Users/me/Library/Application Support/x')
  })

  it('保留 Windows 盘符路径', () => {
    expect(unescapeShellWordLiteral(String.raw`C:\Users\me\file`)).toBe(String.raw`C:\Users\me\file`)
  })
})

describe('scratch 路径含空格（Application Support）', () => {
  const real =
    '/Users/yushen/Library/Application Support/SailFish/agent-workspace/scratch/fireworks-tech-graph'

  it('extract 后路径无残留反斜杠，zone=free，rm 可自动执行', async () => {
    const cmd = String.raw`rm -rf /Users/yushen/Library/Application\ Support/SailFish/agent-workspace/scratch/fireworks-tech-graph`
    const ctx = defaultAuditContext()
    const { calls } = await extractAuditedCalls(cmd, ctx)
    expect(calls[0]?.paths[0]).toBe(real)
    expect(getWorkspaceZone(calls[0].paths[0], ctx.cwd)).toBe('free')

    const assessment = await assessShellRisk(cmd, ctx)
    expect(assessment.level).toBe('safe')
    expect(assessment.calls.flatMap(c => c.reasons).join('')).not.toContain('工作区外')
  })
})
