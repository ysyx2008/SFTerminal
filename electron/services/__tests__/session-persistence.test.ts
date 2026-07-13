import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AgentRecord, AgentStepRecord } from '@shared/types'
import {
  getSessionDirPath,
  listSessionIdsInDateDir,
  readSessionRecord,
  saveSessionRecord,
  updateSessionTitle,
} from '../history/session-persistence'
import { getAgentRecordPath } from '../history/agent-storage'

function makeStep(id: string): AgentStepRecord {
  return {
    id,
    type: 'thought',
    timestamp: Date.now(),
    content: `step ${id}`,
  } as AgentStepRecord
}

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const timestamp = overrides.timestamp ?? new Date('2026-07-13T10:00:00Z').getTime()
  return {
    id: 'sess-1',
    timestamp,
    duration: 100,
    userTask: 'fix nginx',
    terminalId: 'pty-1',
    terminalType: 'local',
    steps: [],
    messages: [],
    status: 'completed',
    ...overrides,
  }
}

describe('session-persistence incremental checkpoint', () => {
  let tmpDir: string
  let agentDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-session-persist-'))
    agentDir = path.join(tmpDir, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('首次保存写成目录格式（meta + jsonl）', () => {
    const record = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
      title: '修 nginx',
    })
    saveSessionRecord(agentDir, record)

    const dateStr = '2026-07-13'
    const dir = getSessionDirPath(agentDir, dateStr, record.id)
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'steps.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'messages.jsonl'))).toBe(true)
    expect(fs.existsSync(getAgentRecordPath(agentDir, dateStr, record.id))).toBe(false)

    const loaded = readSessionRecord(agentDir, dateStr, record.id)
    expect(loaded?.title).toBe('修 nginx')
    expect(loaded?.steps).toHaveLength(1)
    expect(loaded?.messages).toHaveLength(1)
  })

  it('checkpoint 只追加新 steps/messages，不重写已有 jsonl 行', () => {
    const r1 = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
    })
    saveSessionRecord(agentDir, r1)

    const dateStr = '2026-07-13'
    const stepsFile = path.join(getSessionDirPath(agentDir, dateStr, r1.id), 'steps.jsonl')
    const before = fs.readFileSync(stepsFile, 'utf-8')

    const r2 = makeRecord({
      steps: [makeStep('s1'), makeStep('s2')],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ],
      status: 'completed',
      duration: 200,
    })
    saveSessionRecord(agentDir, r2)

    const after = fs.readFileSync(stepsFile, 'utf-8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.split('\n').filter(Boolean)).toHaveLength(2)

    const loaded = readSessionRecord(agentDir, dateStr, r1.id)
    expect(loaded?.steps.map(s => s.id)).toEqual(['s1', 's2'])
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.duration).toBe(200)
  })

  it('仅状态/token 变化且条数不变时只更新 meta', () => {
    const r1 = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
      status: 'completed',
    })
    saveSessionRecord(agentDir, r1)

    const dateStr = '2026-07-13'
    const dir = getSessionDirPath(agentDir, dateStr, r1.id)
    const stepsBefore = fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf-8')
    const mtimeBefore = fs.statSync(path.join(dir, 'steps.jsonl')).mtimeMs

    // 等一拍，确保 mtime 可区分
    const waitUntil = Date.now() + 5
    while (Date.now() < waitUntil) { /* spin */ }

    const r2 = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
      status: 'completed',
      duration: 999,
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    })
    saveSessionRecord(agentDir, r2)

    expect(fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf-8')).toBe(stepsBefore)
    expect(fs.statSync(path.join(dir, 'steps.jsonl')).mtimeMs).toBe(mtimeBefore)

    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'))
    expect(meta.duration).toBe(999)
    expect(meta.tokenUsage.totalTokens).toBe(30)
  })

  it('updateSessionTitle 只改 meta.json', () => {
    const record = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
    })
    saveSessionRecord(agentDir, record)

    const dateStr = '2026-07-13'
    const dir = getSessionDirPath(agentDir, dateStr, record.id)
    const stepsBefore = fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf-8')

    expect(updateSessionTitle(agentDir, dateStr, record.id, '新标题')).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf-8')).toBe(stepsBefore)

    const loaded = readSessionRecord(agentDir, dateStr, record.id)
    expect(loaded?.title).toBe('新标题')
  })

  it('读旧 .json 后 save 迁入目录并删除单体文件', () => {
    const record = makeRecord({
      steps: [makeStep('legacy')],
      messages: [{ role: 'user', content: 'legacy' }],
      title: '旧标题',
    })
    const dateStr = '2026-07-13'
    const legacyPath = getAgentRecordPath(agentDir, dateStr, record.id)
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify(record, null, 2))

    const loaded = readSessionRecord(agentDir, dateStr, record.id)
    expect(loaded?.title).toBe('旧标题')

    loaded!.steps = [...(loaded!.steps || []), makeStep('new')]
    saveSessionRecord(agentDir, loaded!)

    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(path.join(getSessionDirPath(agentDir, dateStr, record.id), 'meta.json'))).toBe(true)
    expect(listSessionIdsInDateDir(agentDir, dateStr)).toEqual([record.id])
  })

  it('forceRewrite 会全量重写 jsonl（即使条数不变）', () => {
    const r1 = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
    })
    saveSessionRecord(agentDir, r1)

    const dateStr = '2026-07-13'
    const stepsFile = path.join(getSessionDirPath(agentDir, dateStr, r1.id), 'steps.jsonl')

    const mutated = makeRecord({
      steps: [{ ...makeStep('s1'), content: 'mutated content' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    saveSessionRecord(agentDir, mutated, { forceRewrite: true })

    const lines = fs.readFileSync(stepsFile, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).content).toBe('mutated content')
  })

  it('append 成功但 meta 未更新（模拟 crash）时下次 save 不重复追加', () => {
    const r1 = makeRecord({
      steps: [makeStep('s1')],
      messages: [{ role: 'user', content: 'hi' }],
    })
    saveSessionRecord(agentDir, r1)

    const dateStr = '2026-07-13'
    const dir = getSessionDirPath(agentDir, dateStr, r1.id)
    const stepsFile = path.join(dir, 'steps.jsonl')
    // 模拟：jsonl 已追加 s2，但 meta.stepCount 仍为 1
    fs.appendFileSync(stepsFile, JSON.stringify(makeStep('s2')) + '\n')
    const metaPath = path.join(dir, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    expect(meta.stepCount).toBe(1)

    const r2 = makeRecord({
      steps: [makeStep('s1'), makeStep('s2'), makeStep('s3')],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
      ],
    })
    saveSessionRecord(agentDir, r2)

    const lines = fs.readFileSync(stepsFile, 'utf-8').split('\n').filter(Boolean)
    expect(lines.map(l => JSON.parse(l).id)).toEqual(['s1', 's2', 's3'])
    const loaded = readSessionRecord(agentDir, dateStr, r1.id)
    expect(loaded?.steps.map(s => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('目录 meta 损坏时回退读旧 .json', () => {
    const record = makeRecord({
      steps: [makeStep('legacy')],
      title: '从旧文件恢复',
    })
    const dateStr = '2026-07-13'
    const legacyPath = getAgentRecordPath(agentDir, dateStr, record.id)
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify(record, null, 2))

    const dir = getSessionDirPath(agentDir, dateStr, record.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), '{not-json')

    const loaded = readSessionRecord(agentDir, dateStr, record.id)
    expect(loaded?.title).toBe('从旧文件恢复')
    expect(loaded?.steps[0].id).toBe('legacy')
  })
})
