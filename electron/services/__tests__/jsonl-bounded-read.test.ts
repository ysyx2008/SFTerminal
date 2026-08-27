import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  HUGE_JSONL_LINE_BYTES,
  createJsonlLineScanner,
  exportJsonlLineToFile,
  stubHugeJsonlLine,
} from '../history/jsonl-bounded-read'
import { countJsonlLines, getSessionDirPath, readSessionRecord, saveSessionRecord } from '../history/session-persistence'
import type { AgentRecord, AgentStepRecord } from '@shared/types'

function scan(text: string, maxBytes = 64) {
  const lines: Array<{ kind: string; bytes?: number; text?: string }> = []
  const scanner = createJsonlLineScanner((line) => {
    if (line.kind === 'ok') lines.push({ kind: 'ok', text: line.text })
    else lines.push({ kind: 'huge', bytes: line.bytes })
  }, maxBytes)
  scanner.feed(text)
  scanner.end()
  return lines
}

describe('jsonl bounded scan', () => {
  it('普通行原样解析', () => {
    expect(scan('{"a":1}\n{"b":2}\n', 1024)).toEqual([
      { kind: 'ok', text: '{"a":1}' },
      { kind: 'ok', text: '{"b":2}' },
    ])
  })

  it('超大行占位且不丢掉后面的小行', () => {
    const huge = 'x'.repeat(200)
    const lines = scan(`{"id":"s1"}\n${huge}\n{"id":"s3"}\n`, 64)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({ kind: 'ok', text: '{"id":"s1"}' })
    expect(lines[1].kind).toBe('huge')
    expect(lines[1].bytes).toBeGreaterThan(64)
    expect(lines[2]).toEqual({ kind: 'ok', text: '{"id":"s3"}' })
  })

})

describe('stubHugeJsonlLine', () => {
  it('从 step 前缀抽出工具名，正文换成占位', () => {
    const head = '{"id":"s9","type":"tool_result","content":"still running","toolName":"execute_command","toolResult":"'
    const stub = stubHugeJsonlLine(
      { bytes: 437_000_000, head: head + '\\u0000\\u0000', tail: '\\u0000","timestamp":1}' },
      '/tmp/steps.jsonl',
      3,
    )
    expect(stub.toolName).toBe('execute_command')
    expect(stub.type).toBe('tool_result')
    expect(stub.toolResult).toContain('437')
    expect((stub.hugeOutput as { bytes: number }).bytes).toBe(437_000_000)
    expect((stub.hugeOutput as { sourceLine: number }).sourceLine).toBe(3)
  })
})

describe('session-persistence huge line', () => {
  it('读会话时超大行占位，前面的步骤还在', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-huge-jsonl-'))
    const agentDir = path.join(dir, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })

    const small: AgentStepRecord = {
      id: 's1',
      type: 'thought',
      timestamp: Date.now(),
      content: 'check cluster',
    }
    const record: AgentRecord = {
      id: 'sess-huge',
      timestamp: new Date('2026-08-27T10:00:00Z').getTime(),
      duration: 10,
      userTask: 'check dm',
      terminalId: 'pty-1',
      terminalType: 'local',
      steps: [small],
      messages: [{ role: 'user', content: 'hi' }],
      status: 'completed',
    }
    saveSessionRecord(agentDir, record)

    const dateStr = '2026-08-27'
    const sessionDir = getSessionDirPath(agentDir, dateStr, record.id)
    const stepsFile = path.join(sessionDir, 'steps.jsonl')
    const pad = 'n'.repeat(HUGE_JSONL_LINE_BYTES + 64)
    const hugeLine = JSON.stringify({
      id: 's2',
      type: 'tool_result',
      content: 'running',
      toolName: 'execute_command',
      toolResult: pad,
      timestamp: Date.now(),
    })
    fs.appendFileSync(stepsFile, hugeLine + '\n')
    const metaPath = path.join(sessionDir, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    meta.stepCount = 2
    fs.writeFileSync(metaPath, JSON.stringify(meta))

    expect(countJsonlLines(stepsFile)).toBe(2)

    const loaded = readSessionRecord(agentDir, dateStr, record.id)
    expect(loaded?.steps).toHaveLength(2)
    expect(loaded?.steps[0].id).toBe('s1')
    expect(loaded?.steps[1].hugeOutput?.skipped).toBe(true)
    expect(loaded?.steps[1].hugeOutput?.bytes).toBeGreaterThan(HUGE_JSONL_LINE_BYTES)
    expect(loaded?.steps[1].toolResult).not.toContain(pad.slice(0, 80))

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('exportJsonlLineToFile', () => {
  it('只导出指定行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-export-jsonl-'))
    const src = path.join(dir, 'steps.jsonl')
    const dest = path.join(dir, 'out.txt')
    fs.writeFileSync(src, '{"a":1}\n{"b":2}\n{"c":3}\n')
    const { bytes } = await exportJsonlLineToFile(src, 1, dest)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('{"b":2}')
    expect(bytes).toBe(Buffer.byteLength('{"b":2}', 'utf8'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
