import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

import { getAgentTools } from '../../tools'
import { managePaneTool } from '../split-pane'

vi.mock('../../../split-pane-bridge.service', () => ({
  splitPaneBridge: {
    exec: vi.fn()
  }
}))

import { splitPaneBridge } from '../../../split-pane-bridge.service'

const exec = vi.mocked(splitPaneBridge.exec)

describe('manage_pane action=open', () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it('opens a local terminal and sets current ptyId', async () => {
    exec.mockResolvedValue({
      ok: true,
      data: { ptyId: 'pty-1', panes: [{ ptyId: 'pty-1', label: '主窗格', isActive: true, terminalType: 'local' }] }
    })
    const setCurrentPtyId = vi.fn()
    const result = await managePaneTool(
      { action: 'open', target: 'local' },
      'assistant-1',
      { setCurrentPtyId } as never
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('execute_command')
    expect(setCurrentPtyId).toHaveBeenCalledWith('pty-1')
    expect(exec).toHaveBeenCalledWith({ type: 'open', target: { kind: 'local' } }, 'assistant-1')
  })

  it('rejects invalid target', async () => {
    const result = await managePaneTool({ action: 'open', target: 'ftp:x' }, 'assistant-1')
    expect(result.success).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('getAgentTools assistant hosted terminal', () => {
  it('exposes manage_pane open and execute_command in assistant mode', () => {
    const tools = getAgentTools(undefined, { mode: 'assistant' })
    const names = tools.map(t => t.function.name)
    expect(names).toContain('manage_pane')
    expect(names).toContain('list_ssh_sessions')
    expect(names).toContain('execute_command')
    const manage = tools.find(t => t.function.name === 'manage_pane')!
    const action = (manage.function.parameters as { properties: { action: { enum: string[] } } }).properties.action
    expect(action.enum).toContain('open')
  })
})
