/**
 * 等后台任务时的卡片文案：必须写清在等哪条命令，而不是只剩一个任务编号
 */
import { describe, it, expect, vi } from 'vitest'

const { tmpUserData } = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { tmpUserData: path.join(os.tmpdir(), `sft-exec-awaiting-${process.pid}`) }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmpUserData),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

import { previewCommand, formatAwaitingTitle } from '../tools/exec'

describe('previewCommand', () => {
  it('压成单行', () => {
    expect(previewCommand('  npm   run \n build  ')).toBe('npm run build')
  })

  it('超长截断并留省略号', () => {
    const preview = previewCommand('x'.repeat(250))
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBe(201)
  })
})

describe('formatAwaitingTitle', () => {
  it('带上任务编号和正在跑的命令', () => {
    const text = formatAwaitingTitle('exec-58', 'npm run build')
    expect(text).toContain('exec-58')
    expect(text).toContain('npm run build')
  })

  it('等关键日志时写明在等什么', () => {
    const text = formatAwaitingTitle('exec-2', 'npm start', 'Listening on')
    expect(text).toContain('exec-2')
    expect(text).toContain('npm start')
    expect(text).toContain('Listening on')
  })
})
