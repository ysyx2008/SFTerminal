/**
 * write_text_file 流式早失败：半截路径碰巧是已有目录时不得误报「文件已存在」。
 * 测试目录全部在 os.tmpdir() 下自建，不依赖某台机器上的真实用户路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
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

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  getApiKey: () => ''
}))

import { getAgentTools } from '../tools'
import type { ToolDefinitionWithMeta } from '../tools'
import { tryParsePartialJson } from '../tool-metadata'

function getStreamValidate() {
  const tools = getAgentTools(undefined, { mode: 'assistant' })
  const write = tools.find((t) => t.function.name === 'write_text_file') as ToolDefinitionWithMeta | undefined
  const validate = write?._meta?.streamValidate
  if (!validate) throw new Error('write_text_file.streamValidate missing')
  return validate
}

function rawWithOpenPath(p: string, extraPrefix = '{"mode":"create","path":'): string {
  return `${extraPrefix}${JSON.stringify(p).slice(0, -1)}`
}

function rawWithClosedPath(p: string, suffix = ',"content":"x'): string {
  return `{"mode":"create","path":${JSON.stringify(p)}${suffix}`
}

describe('write_text_file streamValidate', () => {
  let tmpRoot: string
  let existingDir: string
  let validate: ReturnType<typeof getStreamValidate>

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-stream-validate-'))
    existingDir = path.join(tmpRoot, 'already-there')
    fs.mkdirSync(existingDir)
    validate = getStreamValidate()
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('半截路径等于已有目录时不早失败（补全解析会把前缀当成完整 path）', () => {
    const intended = path.join(existingDir, 'new-file.txt')
    const raw = rawWithOpenPath(existingDir)
    const parsed = tryParsePartialJson(raw)
    expect(parsed?.path).toBe(existingDir)
    expect(fs.existsSync(existingDir)).toBe(true)
    expect(validate(parsed!, raw)).toBeNull()
    expect(intended.startsWith(existingDir)).toBe(true)
  })

  it('半截路径等于临时根目录时不早失败', () => {
    const raw = rawWithOpenPath(tmpRoot)
    const parsed = tryParsePartialJson(raw)
    expect(parsed?.path).toBe(tmpRoot)
    expect(validate(parsed!, raw)).toBeNull()
  })

  it('路径已写完且目标文件已存在时早失败', () => {
    const filePath = path.join(existingDir, 'exists.txt')
    fs.writeFileSync(filePath, 'old')
    const raw = rawWithClosedPath(filePath)
    const parsed = tryParsePartialJson(raw)
    expect(validate(parsed!, raw)).toMatch(/已存在/)
  })

  it('路径已写完且目标不存在时不早失败', () => {
    const filePath = path.join(existingDir, 'brand-new.txt')
    const raw = rawWithClosedPath(filePath)
    const parsed = tryParsePartialJson(raw)
    expect(validate(parsed!, raw)).toBeNull()
  })

  it('mode 不是 create 时即使文件已存在也不早失败', () => {
    const filePath = path.join(existingDir, 'exists.txt')
    fs.writeFileSync(filePath, 'old')
    const raw = `{"mode":"overwrite","path":${JSON.stringify(filePath)},"content":"x`
    const parsed = tryParsePartialJson(raw)
    expect(validate(parsed!, raw)).toBeNull()
  })
})
