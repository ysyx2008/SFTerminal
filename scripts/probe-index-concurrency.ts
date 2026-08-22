/**
 * 索引追加日志的多进程 / 崩溃场景演练。
 *
 * 单测里的"两个实例"仍在同一个进程内，OS 层的交错写没被真正验证过。这里起真实子进程，
 * 让它们同时往一份索引里写，再把进程从中间打断，看剩下的数据还读不读得出来。
 *
 *   npx tsx scripts/probe-index-concurrency.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fork } from 'child_process'
import { AgentIndexLog } from '../electron/services/history/agent-index-log'

interface Entry { id: string; n: number; pad: string }

const out = (s: string) => process.stdout.write(s + '\n')
const WORKER_FLAG = '--worker'

/** 子进程模式：往指定日志里写 count 条，id 带 tag 前缀 */
if (process.argv.includes(WORKER_FLAG)) {
  const [, , , logPath, tag, countStr, padStr] = process.argv
  const log = new AgentIndexLog<Entry>(logPath)
  const count = Number(countStr)
  const pad = 'x'.repeat(Number(padStr))
  for (let i = 0; i < count; i++) {
    log.put({ id: `${tag}-${i}`, n: i, pad })
  }
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idxconc-'))
const self = path.resolve(__filename)

function spawnWorker(logPath: string, tag: string, count: number, pad = 0) {
  return new Promise<void>((resolve, reject) => {
    const child = fork(self, [WORKER_FLAG, logPath, tag, String(count), String(pad)], {
      execArgv: ['--import', 'tsx'],
      stdio: 'inherit',
    })
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exit ${code}`))))
  })
}

async function concurrentWrites(): Promise<void> {
  out('\n=== 多进程同时写同一份索引 ===')
  const logPath = path.join(tmp, 'concurrent.jsonl')
  const workers = 4
  const perWorker = 500

  const t = Date.now()
  await Promise.all(
    Array.from({ length: workers }, (_, i) => spawnWorker(logPath, `w${i}`, perWorker))
  )
  const elapsed = Date.now() - t

  const log = new AgentIndexLog<Entry>(logPath)
  const entries = log.entries()
  const expected = workers * perWorker
  const ids = new Set(entries.map(e => e.id))

  out(`${workers} 个进程 × ${perWorker} 条，用时 ${elapsed}ms`)
  out(`期望 ${expected} 条，实际 ${entries.length} 条，唯一 id ${ids.size} 个`)

  let lost = 0
  for (let w = 0; w < workers; w++) {
    for (let i = 0; i < perWorker; i++) {
      if (!ids.has(`w${w}-${i}`)) lost++
    }
  }
  out(lost === 0 ? '结论：无条目丢失 ✓' : `!!! 丢失 ${lost} 条 !!!`)
  if (lost) process.exitCode = 1
}

async function concurrentWithCompaction(): Promise<void> {
  out('\n=== 多进程同时写 + 触发压实（条目撑大以越过体积门槛） ===')
  const logPath = path.join(tmp, 'compact.jsonl')
  const workers = 4
  const perWorker = 400

  // 先写一轮再重复写，制造冗余；pad 让文件越过 2MB 压实门槛
  await Promise.all(
    Array.from({ length: workers }, (_, i) => spawnWorker(logPath, `w${i}`, perWorker, 2048))
  )
  await Promise.all(
    Array.from({ length: workers }, (_, i) => spawnWorker(logPath, `w${i}`, perWorker, 2048))
  )

  const entries = new AgentIndexLog<Entry>(logPath).entries()
  const ids = new Set(entries.map(e => e.id))
  const expected = workers * perWorker
  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').length

  out(`期望 ${expected} 条，实际唯一 id ${ids.size} 个，文件 ${lines} 行`)
  out(ids.size === expected ? '结论：压实与并发写共存，无丢失 ✓' : '!!! 压实期间丢了条目 !!!')
  if (ids.size !== expected) process.exitCode = 1
}

async function killMidWrite(): Promise<void> {
  out('\n=== 写入过程中被强杀（模拟崩溃 / 断电） ===')
  const logPath = path.join(tmp, 'killed.jsonl')

  const child = fork(self, [WORKER_FLAG, logPath, 'k', '200000', '256'], {
    execArgv: ['--import', 'tsx'],
    stdio: 'inherit',
  })
  await new Promise(r => setTimeout(r, 1200))
  child.kill('SIGKILL')
  await new Promise(r => child.on('exit', r))

  const raw = fs.readFileSync(logPath, 'utf-8')
  const endsClean = raw.endsWith('\n')
  const entries = new AgentIndexLog<Entry>(logPath).entries()

  out(`被杀时文件 ${(raw.length / 1024 / 1024).toFixed(1)}MB，尾部${endsClean ? '恰好完整' : '是半行'}`)
  out(`仍能读出 ${entries.length} 条`)

  // 崩溃后继续写，之前的条目不能受影响
  const log = new AgentIndexLog<Entry>(logPath)
  const before = log.entries().length
  log.put({ id: 'after-crash', n: -1, pad: '' })
  const reopened = new AgentIndexLog<Entry>(logPath).entries()

  const ok = reopened.some(e => e.id === 'after-crash') && reopened.length >= before
  out(ok ? '结论：崩溃后可继续追加，旧条目未受影响 ✓' : '!!! 崩溃后数据受损 !!!')
  if (!ok) process.exitCode = 1
}

async function main(): Promise<void> {
  try {
    await concurrentWrites()
    await concurrentWithCompaction()
    await killMidWrite()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    out('')
  }
}

void main()
