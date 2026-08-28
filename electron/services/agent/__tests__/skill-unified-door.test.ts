/**
 * 这场对话里装上、卸掉技能只走 skill load/unload。
 */
import { describe, it, expect, vi } from 'vitest'

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

vi.mock('../../user-skill.service', () => {
  const skills: Record<string, { id: string; name: string; enabled: boolean; content: string }> = {
    'my-skill': { id: 'my-skill', name: '我的技能', enabled: true, content: '自定义技能正文' }
  }
  return {
    USER_SKILL_ID_PREFIX: 'user:',
    toUserSkillId: (id: string) => id.startsWith('user:') ? id : `user:${id}`,
    parseUserSkillId: (id: string) => {
      if (!id.startsWith('user:')) return null
      return id.slice(5) || null
    },
    getUserSkillService: () => ({
      getSkill: (id: string) => skills[id],
      getSkillContent: (id: string) => skills[id]?.content ?? null,
      getEnabledSkills: () => Object.values(skills)
    })
  }
})

import { loadSkillTool, unloadSkillTool } from '../tools/misc'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(): ToolExecutorConfig & { loadedUser: Set<string> } {
  const loadedUser = new Set<string>()
  const executor = {
    loadedUser,
    addStep: vi.fn(),
    skillSession: {
      getLoadedSkills: () => [],
      loadSkill: vi.fn(),
      unloadSkill: vi.fn()
    },
    isUserSkillLoaded: (id: string) => loadedUser.has(id) || loadedUser.has(`user:${id}`),
    markUserSkillLoaded: (id: string) => { loadedUser.add(id) },
    markSkillUnloaded: (id: string) => {
      loadedUser.delete(id)
      loadedUser.delete(id.startsWith('user:') ? id.slice(5) : `user:${id}`)
    }
  }
  return executor as unknown as ToolExecutorConfig & { loadedUser: Set<string> }
}

describe('skill load/unload 也管用户技能', () => {
  it('load 能装上用户技能', async () => {
    const executor = makeExecutor()
    const result = await loadSkillTool({ skill_id: 'my-skill' }, {} as never, executor)
    expect(result.success).toBe(true)
    expect(result.output).toContain('自定义技能正文')
    expect(executor.isUserSkillLoaded?.('user:my-skill')).toBe(true)
  })

  it('load 也认 user: 前缀', async () => {
    const executor = makeExecutor()
    const result = await loadSkillTool({ skill_id: 'user:my-skill' }, {} as never, executor)
    expect(result.success).toBe(true)
    expect(executor.isUserSkillLoaded?.('user:my-skill')).toBe(true)
  })

  it('unload 能卸掉用户技能，且不算用户点掉', async () => {
    const executor = makeExecutor()
    await loadSkillTool({ skill_id: 'my-skill' }, {} as never, executor)
    const result = await unloadSkillTool({ skill_id: 'my-skill' }, executor)
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/已卸载|unloaded/i)
    expect(executor.isUserSkillLoaded?.('user:my-skill')).toBe(false)
    expect(executor.isUserSkillLoaded?.('my-skill')).toBe(false)
  })

  it('未装上时 unload 用户技能不报错', async () => {
    const executor = makeExecutor()
    const result = await unloadSkillTool({ skill_id: 'my-skill' }, executor)
    expect(result.success).toBe(true)
    expect(result.output).toMatch(/未加载|not loaded/i)
  })
})
