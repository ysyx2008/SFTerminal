/**
 * 索引追加日志的真实数据演练。
 *
 * 拿真实索引的**副本**跑转换，逐条深度比对，再把新旧两种写法的耗时放在一起测。
 * 全程只读原数据，所有写操作都发生在临时目录。
 *
 *   npx tsx scripts/probe-index-log.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentIndexLog } from '../electron/services/history/agent-index-log'

interface Entry { id: string; [k: string]: unknown }

const DATA = path.join(os.homedir(), 'Library/Application Support/SailFish/history')
const out = (s: string) => process.stdout.write(s + '\n')

const ms = (fn: () => void): number => {
  const t = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - t) / 1e6
}

/** 深度比较，用于确认转换没有悄悄改动任何字段 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(k => deepEqual((a as never)[k], (b as never)[k]))
}

function run(name: string): void {
  const src = path.join(DATA, `${name}.json`)
  if (!fs.existsSync(src)) { out(`跳过 ${name}（不存在）`); return }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idxprobe-'))
  const legacy = path.join(tmp, `${name}.json`)
  const logPath = path.join(tmp, `${name}.jsonl`)
  fs.copyFileSync(src, legacy)

  const original = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as Entry[]
  const bytes = fs.statSync(legacy).size
  out(`\n=== ${name}：${original.length} 条 / ${(bytes / 1024 / 1024).toFixed(1)}MB ===`)

  // --- 转换 ---
  const log = new AgentIndexLog<Entry>(logPath)
  const convertMs = ms(() => log.replaceAll(original))
  out(`转换耗时                ${convertMs.toFixed(1)}ms`)
  out(`转换后体积              ${(fs.statSync(logPath).size / 1024 / 1024).toFixed(1)}MB`)

  // --- 逐条等价比对（从磁盘重新装载，确保比的是落盘结果） ---
  const reloaded = new AgentIndexLog<Entry>(logPath)
  const after = reloaded.entries()
  const byId = new Map(after.map(e => [e.id, e]))
  // 原索引可能自带重复 id（旧写法 upsert 失败的残留），以最后一条为准，与日志语义一致
  const expected = new Map(original.map(e => [e.id, e]))

  let mismatch = 0, missing = 0
  for (const [id, want] of expected) {
    const got = byId.get(id)
    if (!got) { missing++; continue }
    if (!deepEqual(want, got)) mismatch++
  }
  const extra = after.length - expected.size
  out(`唯一 id                 ${expected.size}（原数组 ${original.length} 条，重复 ${original.length - expected.size}）`)
  out(`比对结果                缺失 ${missing} / 字段不一致 ${mismatch} / 多出 ${extra}`)
  if (missing || mismatch || extra) {
    out('!!! 转换不等价，停止 !!!')
    process.exitCode = 1
    return
  }

  // --- 写入耗时对照 ---
  const one = original[Math.floor(original.length / 2)]

  // 旧法：读回整个数组 + 改一条 + 整体写回（即改动前的实现）
  const legacyWrite = ms(() => {
    const arr = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as Entry[]
    const i = arr.findIndex(e => e.id === one.id)
    arr[i] = { ...one, timestamp: Date.now() }
    const tmpFile = legacy + '.tmp'
    fs.writeFileSync(tmpFile, JSON.stringify(arr))
    fs.renameSync(tmpFile, legacy)
  })

  // 新法：追加一行
  const appendWrite = ms(() => reloaded.put({ ...one, timestamp: Date.now() }))

  out(`单次写入 · 旧（全量重写）${legacyWrite.toFixed(2)}ms`)
  out(`单次写入 · 新（追加一行）${appendWrite.toFixed(3)}ms   → 快 ${(legacyWrite / appendWrite).toFixed(0)} 倍`)

  // --- 读取耗时 ---
  const coldMs = ms(() => { new AgentIndexLog<Entry>(logPath).entries() })
  // 他进程追加后本进程的增量读
  new AgentIndexLog<Entry>(logPath).put({ ...one, timestamp: Date.now() })
  const incMs = ms(() => reloaded.entries())
  out(`冷启动全量读            ${coldMs.toFixed(1)}ms`)
  out(`他进程追加后增量读      ${incMs.toFixed(3)}ms`)

  // --- 一个 20 步任务的索引总开销 ---
  out(`20 步任务索引开销 · 旧  ${(legacyWrite * 20).toFixed(0)}ms`)
  out(`20 步任务索引开销 · 新  ${(appendWrite * 20).toFixed(1)}ms`)

  fs.rmSync(tmp, { recursive: true, force: true })
}

run('agent-index')
run('watch-index')
out('')
