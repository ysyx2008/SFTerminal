/**
 * 索引追加日志的行为契约。
 *
 * 重点不在"能存能取"，而在几件出错时不会有任何信号的事：他进程追加后本进程能不能看见、
 * 压实之后条目会不会少、写到一半崩了下次还能不能读。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentIndexLog } from '../agent-index-log'

/** 压实靠 rename 换文件，要验"换失败了会怎样"就得能让它失败；默认原样透传 */
const faults = vi.hoisted(() => ({ failRename: false }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  const renameSync: typeof actual.renameSync = (...args) => {
    if (faults.failRename) throw new Error('EACCES: simulated')
    return actual.renameSync(...args)
  }
  return { ...actual, default: { ...actual, renameSync }, renameSync }
})

interface Entry {
  id: string
  timestamp: number
  userTask: string
}

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  id,
  timestamp: 1000,
  userTask: `任务 ${id}`,
  ...over,
})

let dir: string
let logPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idxlog-'))
  logPath = path.join(dir, 'test-index.jsonl')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const sortedIds = (log: AgentIndexLog<Entry>) => log.entries().map(e => e.id).sort()

/** 日志里的数据行数（首行是 generation header，不是数据） */
function dataLines(file = logPath): number {
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim() && !l.includes('"op":"head"'))
    .length
}

describe('基本读写', () => {
  it('put 后能读回，get 按 id 命中', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))
    log.put(entry('b'))

    expect(sortedIds(log)).toEqual(['a', 'b'])
    expect(log.get('a')?.userTask).toBe('任务 a')
    expect(log.get('missing')).toBeUndefined()
    expect(log.size()).toBe(2)
  })

  it('同 id 重复写：后写的胜出，条目数不增加', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a', { userTask: '旧' }))
    log.put(entry('a', { userTask: '新' }))

    expect(log.size()).toBe(1)
    expect(log.get('a')?.userTask).toBe('新')
  })

  it('delete 写墓碑，重新装载后依然不见', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))
    log.put(entry('b'))
    log.delete('a')

    expect(sortedIds(log)).toEqual(['b'])

    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(sortedIds(reopened)).toEqual(['b'])
  })

  it('文件不存在时是空集合，不抛错', () => {
    const log = new AgentIndexLog<Entry>(path.join(dir, 'nope.jsonl'))
    expect(log.entries()).toEqual([])
    expect(log.size()).toBe(0)
    expect(log.exists()).toBe(false)
  })

  it('replaceAll 写成紧凑日志，条目等价且无冗余行', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))
    log.put(entry('a', { userTask: '改过' }))
    log.put(entry('b'))

    log.replaceAll([entry('x'), entry('y')])

    expect(sortedIds(log)).toEqual(['x', 'y'])
    expect(dataLines()).toBe(2)
  })
})

describe('增量读：他进程追加后要看得见', () => {
  it('另一个实例追加，本实例下次访问就能看到（不必重读全文件）', () => {
    const mine = new AgentIndexLog<Entry>(logPath)
    mine.put(entry('a'))
    expect(sortedIds(mine)).toEqual(['a'])

    const theirs = new AgentIndexLog<Entry>(logPath)
    theirs.put(entry('b'))

    expect(sortedIds(mine)).toEqual(['a', 'b'])
  })

  it('两个实例交错写，谁的条目都不会被抹掉', () => {
    const one = new AgentIndexLog<Entry>(logPath)
    const two = new AgentIndexLog<Entry>(logPath)

    one.put(entry('a1'))
    two.put(entry('b1'))
    one.put(entry('a2'))
    two.put(entry('b2'))

    expect(sortedIds(one)).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect(sortedIds(two)).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('他进程删除，本实例也要跟着看不到', () => {
    const mine = new AgentIndexLog<Entry>(logPath)
    mine.put(entry('a'))
    mine.put(entry('b'))
    expect(sortedIds(mine)).toEqual(['a', 'b'])

    new AgentIndexLog<Entry>(logPath).delete('a')

    expect(sortedIds(mine)).toEqual(['b'])
  })

  it('他进程整体替换（文件变短）后，本实例全量重读而不是接着旧偏移读', () => {
    const mine = new AgentIndexLog<Entry>(logPath)
    for (let i = 0; i < 20; i++) mine.put(entry(`e${i}`))
    expect(mine.size()).toBe(20)

    new AgentIndexLog<Entry>(logPath).replaceAll([entry('only')])

    expect(sortedIds(mine)).toEqual(['only'])
  })
})

describe('损坏与中断', () => {
  it('中间有损坏行：跳过它，其余条目照常读出', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))
    fs.appendFileSync(logPath, '{这不是合法 JSON}\n')
    log.invalidate()
    log.put(entry('b'))

    expect(sortedIds(log)).toEqual(['a', 'b'])
  })

  it('尾部半行（写到一半崩溃）：不影响已完整落盘的条目', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))
    log.put(entry('b'))
    fs.appendFileSync(logPath, '{"op":"put","e":{"id":"half"')

    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(sortedIds(reopened)).toEqual(['a', 'b'])
  })

  it('半行之后补齐成完整行：补齐的那条能被读到', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))

    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(sortedIds(reopened)).toEqual(['a'])

    // 模拟：上次读停在完整行边界，之后剩余部分被补齐
    fs.appendFileSync(logPath, JSON.stringify({ op: 'put', e: entry('b') }) + '\n')
    expect(sortedIds(reopened)).toEqual(['a', 'b'])
  })
})

describe('压实', () => {
  /** 撑出足够大的条目，让压实的体积门槛能被触发 */
  const fat = (id: string) => entry(id, { userTask: 'x'.repeat(4096) })

  it('冗余积累到阈值且文件够大时自动压实，条目不变、文件行数远少于写入次数', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    const writes = 200 * 4
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    }

    expect(log.size()).toBe(200)
    // 压实后文件缩回体积门槛以下就不再压，所以最终行数不是定值；
    // 要验的是"压实确实发生过"——没压的话这里会是全部 800 行。
    expect(dataLines()).toBeLessThan(writes)

    // 压实后重新装载，条目必须完全一致
    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(reopened.size()).toBe(200)
    expect(sortedIds(reopened)).toEqual(sortedIds(log))
  })

  it('文件很小时即使冗余率高也不压实，避免小文件反复重写', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    for (let i = 0; i < 50; i++) log.put(entry('same', { timestamp: i }))

    expect(dataLines()).toBe(50)
    expect(log.size()).toBe(1)
  })

  it('他进程压实换掉文件后，本实例不会照着旧偏移读出半行', () => {
    const mine = new AgentIndexLog<Entry>(logPath)
    for (let i = 0; i < 30; i++) mine.put(entry(`e${i}`))
    expect(mine.size()).toBe(30)

    // 他进程压实：文件被整个换掉，但压实后可能比本实例的读偏移更长
    const theirs = new AgentIndexLog<Entry>(logPath)
    theirs.replaceAll(Array.from({ length: 60 }, (_, i) => entry(`c${i}`)))

    expect(sortedIds(mine)).toEqual(sortedIds(theirs))
    expect(mine.size()).toBe(60)
  })

  it('压实前会先并入他进程刚写的条目，不把别人的写入抹掉', () => {
    const compactor = new AgentIndexLog<Entry>(logPath)
    for (let i = 0; i < 200; i++) compactor.put(fat(`e${i}`))
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 200; i++) compactor.put(fat(`e${i}`))
    }

    // 他进程写入一条，compactor 的内存态还不知道
    new AgentIndexLog<Entry>(logPath).put(fat('from-other'))

    // 再写到触发压实
    for (let i = 0; i < 200; i++) compactor.put(fat(`e${i}`))

    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(reopened.get('from-other')).toBeDefined()
    expect(reopened.size()).toBe(201)
  })

  it('压实锁被他进程占着时跳过压实，数据仍然正确', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    fs.writeFileSync(`${logPath}.compact.lock`, '99999')

    for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    }

    expect(log.size()).toBe(200)
    const reopened = new AgentIndexLog<Entry>(logPath)
    expect(reopened.size()).toBe(200)
  })

  it('压实写盘失败时，条目不丢、还能继续读写', () => {
    const log = new AgentIndexLog<Entry>(logPath)
    for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    }

    faults.failRename = true
    try {
      for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    } finally {
      faults.failRename = false
    }

    // 压实没成功，但保存记录这件事不能受影响
    expect(log.size()).toBe(200)
    log.put(entry('after-failure'))
    expect(log.get('after-failure')).toBeDefined()
    expect(new AgentIndexLog<Entry>(logPath).size()).toBe(201)
  })

  it('夺走陈旧锁的进程，其锁不会被原持锁者释放时误删', () => {
    const lockPath = `${logPath}.compact.lock`
    const log = new AgentIndexLog<Entry>(logPath)
    log.put(entry('a'))

    // 别人持有的锁
    fs.writeFileSync(lockPath, '99999:other')
    // 本实例释放锁（它并没有持有）
    ;(log as unknown as { releaseCompactLock(): void }).releaseCompactLock()

    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('99999:other')
  })

  it('initializeIfAbsent：只有第一个调用者能建，后来者不覆盖', () => {
    const first = new AgentIndexLog<Entry>(logPath)
    expect(first.initializeIfAbsent([entry('a'), entry('b')])).toBe(true)

    // 建好之后又写进来一条
    new AgentIndexLog<Entry>(logPath).put(entry('c'))

    // 后来者拿着旧快照来初始化：必须被拒，否则会盖掉 c
    const second = new AgentIndexLog<Entry>(logPath)
    expect(second.initializeIfAbsent([entry('a'), entry('b')])).toBe(false)
    expect(sortedIds(new AgentIndexLog<Entry>(logPath))).toEqual(['a', 'b', 'c'])
  })

  it('陈旧锁（持锁进程已崩溃）不会永久挡住压实', () => {
    const lockPath = `${logPath}.compact.lock`
    fs.writeFileSync(lockPath, '99999')
    const old = Date.now() - 10 * 60 * 1000
    fs.utimesSync(lockPath, new Date(old), new Date(old))

    const log = new AgentIndexLog<Entry>(logPath)
    const writes = 200 * 4
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 200; i++) log.put(fat(`e${i}`))
    }

    expect(dataLines()).toBeLessThan(writes)
    expect(log.size()).toBe(200)
  })
})
