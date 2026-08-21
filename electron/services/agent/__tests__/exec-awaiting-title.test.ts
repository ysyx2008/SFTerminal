/**
 * 等后台任务时的卡片文案：任务编号 + 已运行多久，不抄命令、不亮内部等待记号
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

import { formatAwaitingTitle } from '../tools/exec'

describe('formatAwaitingTitle', () => {
  it('带上任务编号和已运行时长', () => {
    const text = formatAwaitingTitle('exec-58', '3秒')
    expect(text).toContain('exec-58')
    expect(text).toContain('3秒')
  })

  it('不把命令或内部等待记号写进标题', () => {
    const text = formatAwaitingTitle('exec-2', '1分钟')
    expect(text).not.toMatch(/npm|python|Listening|🍕/i)
  })
})
