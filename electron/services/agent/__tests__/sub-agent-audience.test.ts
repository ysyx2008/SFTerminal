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

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  getApiKey: () => '',
}))

import { describe, it, expect, vi } from 'vitest'
import { getAgentTools, filterSubAgentTools } from '../tools'
import { getSubAgentTools } from '../tools/sub-agent'
import { emailTools } from '../skills/email/tools'
import { calendarTools } from '../skills/calendar/tools'
import { watchTools } from '../skills/watch/tools'

describe('伙计工具面', () => {
  it('清单含读写和 exec，不含提问/派遣/发信/关切', () => {
    const names = getSubAgentTools().map(t => t.function.name)
    expect(names).toContain('exec')
    expect(names).toContain('read_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('write_text_file')
    expect(names).toContain('skill')
    expect(names).not.toContain('ask_user')
    expect(names).not.toContain('talk_to_user')
    expect(names).not.toContain('plan')
    expect(names).not.toContain('dispatch_agents')
    expect(names).not.toContain('followup_agent')
    expect(names).not.toContain('wait_agents')
    expect(names).not.toContain('interrupt_agent')
    expect(names).not.toContain('manage_pane')
    expect(names).not.toContain('send_to_chat')
  })

  it('伙计看到的 exec 说明是拦住，不是确认或自由放行', () => {
    const child = filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant' }))
    const exec = child.find(t => t.function.name === 'exec')
    expect(exec?.function.description).toContain('一律拦住')
    expect(exec?.function.description).toContain('不会问人签字')
    expect(exec?.function.description).not.toContain('free 放行')
    expect(exec?.function.description).not.toContain('需确认')
  })

  it('过滤只认元数据，不认工具名', () => {
    const parent = getAgentTools(undefined, { mode: 'assistant' })
    const child = filterSubAgentTools(parent)
    expect(child.every(t => (t as { _meta?: { allowedForSubAgent?: boolean } })._meta?.allowedForSubAgent !== false)).toBe(true)
  })

  it('发信和改日程标成伙计不能用', () => {
    expect(emailTools.find(t => t.function.name === 'email_send')).toMatchObject({ _meta: { allowedForSubAgent: false } })
    expect(calendarTools.find(t => t.function.name === 'calendar_create')).toMatchObject({ _meta: { allowedForSubAgent: false } })
    expect(watchTools.every(t => (t as { _meta?: { allowedForSubAgent?: boolean } })._meta?.allowedForSubAgent === false)).toBe(true)
  })
})
