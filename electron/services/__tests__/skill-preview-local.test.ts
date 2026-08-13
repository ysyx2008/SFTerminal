/**
 * 本地技能预览：独立 .md、已安装技能 ID（含前导斜杠）、目录形态
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ConfigService } from '../config.service'

const mockUserData = path.join(os.tmpdir(), `sft-skill-preview-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
  shell: { openPath: vi.fn() },
}))

import { UserSkillService } from '../user-skill.service'
import { SkillMarketService, asInstalledSkillId } from '../skill-market.service'

const SKILL_MD = `---
name: IT 项目评审
description: 评审检查清单
version: "1.0"
enabled: true
---

# 评审要点
检查范围与风险。
`

function makeMarket(userSkillService: UserSkillService): SkillMarketService {
  const config = { get: () => '', set: () => {} } as unknown as ConfigService
  return new SkillMarketService(config, userSkillService)
}

describe('asInstalledSkillId', () => {
  it('strips leading slash and .md suffix', () => {
    expect(asInstalledSkillId('/it-project-review')).toBe('it-project-review')
    expect(asInstalledSkillId('it-project-review.md')).toBe('it-project-review')
    expect(asInstalledSkillId('it-project-review')).toBe('it-project-review')
  })

  it('rejects filesystem paths and invalid IDs', () => {
    expect(asInstalledSkillId('/tmp/foo')).toBeUndefined()
    expect(asInstalledSkillId('C:\\skills\\foo')).toBeUndefined()
    expect(asInstalledSkillId('../escape')).toBeUndefined()
    expect(asInstalledSkillId('foo bar')).toBeUndefined()
    expect(asInstalledSkillId('not a path')).toBeUndefined()
  })
})

describe('previewLocalSkill', () => {
  let userSkillService: UserSkillService
  let market: SkillMarketService
  let skillsDir: string

  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    userSkillService = new UserSkillService()
    skillsDir = userSkillService.getSkillsDir()
    market = makeMarket(userSkillService)
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('previews a standalone .md file by path', () => {
    const mdPath = path.join(skillsDir, 'it-project-review.md')
    fs.writeFileSync(mdPath, SKILL_MD, 'utf-8')

    const result = market.previewLocalSkill(mdPath)
    expect(result.success).toBe(true)
    expect(result.content).toContain('评审要点')
    expect(result.skill?.id).toBe('it-project-review')
  })

  it('previews an installed file-form skill by ID, including a leading slash', () => {
    const mdPath = path.join(skillsDir, 'it-project-review.md')
    fs.writeFileSync(mdPath, SKILL_MD, 'utf-8')
    userSkillService.refresh()

    const byId = market.previewLocalSkill('it-project-review', { resolveInstalledId: true })
    expect(byId.success).toBe(true)
    expect(byId.fromInstalled).toBe(true)
    expect(byId.content).toContain('评审要点')

    const bySlash = market.previewLocalSkill('/it-project-review', { resolveInstalledId: true })
    expect(bySlash.success).toBe(true)
    expect(bySlash.fromInstalled).toBe(true)
    expect(bySlash.content).toContain('评审要点')
    expect(bySlash.error).toBeUndefined()
  })

  it('previews a directory-form skill by ID', () => {
    const dir = path.join(skillsDir, 'dir-skill')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf-8')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'extra', 'utf-8')
    userSkillService.refresh()

    const result = market.previewLocalSkill('dir-skill', { resolveInstalledId: true })
    expect(result.success).toBe(true)
    expect(result.content).toContain('评审要点')
    expect(result.files).toContain('notes.txt')
  })

  it('reports Skill not found for a missing ID instead of treating it as /root', () => {
    const result = market.previewLocalSkill('/no-such-skill', { resolveInstalledId: true })
    expect(result.success).toBe(false)
    expect(result.error).toBe('Skill not found: no-such-skill')
  })

  it('does not treat a root-level SKILL.md as the whole skills directory', () => {
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), SKILL_MD, 'utf-8')
    fs.writeFileSync(path.join(skillsDir, 'other.md'), '---\nname: other\n---\n# other\n', 'utf-8')
    userSkillService.refresh()

    const result = market.previewLocalSkill('SKILL', { resolveInstalledId: true })
    expect(result.success).toBe(true)
    expect(result.content).toContain('评审要点')
    expect(result.content).not.toContain('# other')
    expect(result.files ?? []).toHaveLength(0)
  })

  it('does not resolve installed IDs unless asked (install path)', () => {
    const mdPath = path.join(skillsDir, 'it-project-review.md')
    fs.writeFileSync(mdPath, SKILL_MD, 'utf-8')
    userSkillService.refresh()

    const result = market.previewLocalSkill('/it-project-review')
    expect(result.success).toBe(false)
    expect(result.fromInstalled).toBeUndefined()
    expect(result.error).toMatch(/^Path not found:/)
  })

  it('marks path previews as not fromInstalled', () => {
    const mdPath = path.join(skillsDir, 'it-project-review.md')
    fs.writeFileSync(mdPath, SKILL_MD, 'utf-8')

    const result = market.previewLocalSkill(mdPath)
    expect(result.success).toBe(true)
    expect(result.fromInstalled).toBeUndefined()
  })

  it('keeps Path not found for a missing filesystem path', () => {
    const missing = path.join(mockUserData, 'not-here', 'pack.zip')
    const result = market.previewLocalSkill(missing)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^Path not found:/)
  })
})
