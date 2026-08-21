/**
 * 本机文件工具的路径解析：相对路径只认本机目录，不拿远程 cwd 往本机上拼。
 */
import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../user-skill.service', () => ({
  getUserSkillService: () => ({ getEnabledSkills: () => [] })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

import { resolveLocalFilePath } from '../tools/file'
import { getAgentTools } from '../tools'

describe('resolveLocalFilePath', () => {
  it('绝对路径原样返回', () => {
    const abs = path.join(os.homedir(), 'doc.md')
    expect(resolveLocalFilePath(abs, { type: 'ssh', cwd: '/var/www' })).toBe(abs)
  })

  it('~ 展开为本机主目录', () => {
    expect(resolveLocalFilePath('~/notes.md', { type: 'ssh', cwd: '/home/ubuntu' }))
      .toBe(path.join(os.homedir(), 'notes.md'))
  })

  it('本机终端：相对路径跟该终端当前目录走', () => {
    const localCwd = path.join(os.tmpdir(), 'sailfish-local-cwd')
    expect(resolveLocalFilePath('notes.md', { type: 'local', cwd: localCwd }))
      .toBe(path.join(localCwd, 'notes.md'))
  })

  it('远程窗格：相对路径落到本机主目录，不跟远程目录拼', () => {
    expect(resolveLocalFilePath('notes.md', { type: 'ssh', cwd: '/home/ubuntu/app' }))
      .toBe(path.join(os.homedir(), 'notes.md'))
    expect(resolveLocalFilePath('notes.md', { type: 'ssh', cwd: '/home/ubuntu/app' }))
      .not.toBe(path.join('/home/ubuntu/app', 'notes.md'))
  })

  it('没有本机终端时相对路径落到本机主目录', () => {
    expect(resolveLocalFilePath('notes.md', null)).toBe(path.join(os.homedir(), 'notes.md'))
    expect(resolveLocalFilePath('notes.md', undefined)).toBe(path.join(os.homedir(), 'notes.md'))
  })
})

describe('SSH 模式本机文件工具可见', () => {
  it('远程会话能看到读、写、改、搜索本机文件', () => {
    const names = getAgentTools(undefined, { mode: 'ssh' }).map(t => t.function.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_text_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('file_search')
    expect(names).toContain('write_remote_text_file')
    expect(names).not.toContain('dispatch_agents')
  })
})
