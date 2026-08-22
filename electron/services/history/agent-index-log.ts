/**
 * 索引追加日志 —— 只在文件尾部增长的索引存储。
 *
 * 为什么不是"一个 JSON 数组、每次全量重写"：那种写法保存一条记录要把全部条目读进来、
 * 解析、序列化、再整个写回，代价随历史总量线性增长。实测 33130 条（16.5MB）时单次
 * 66ms，全部落在主线程上，而 checkpoint 每轮工具调用都会触发一次。
 *
 * 追加日志把写变成 O(1)：一条记录一行，同 id 后写的胜出，删除写一条墓碑。读则靠记住
 * 上次读到的字节位置，只消费新增的那一段——因为文件只在尾部长，这一点成立。冗余积累到
 * 一定程度再压实成紧凑形式，成本摊销到两次压实之间的追加上，仍是常数。
 *
 * 本模块只管"带 id 的条目集合怎么存"，不认识会话语义，因此可独立测试。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../utils/logger'

const log = createLogger('AgentIndexLog')

/** 压实触发：冗余行数达到唯一条目数的这个倍数 */
const COMPACT_REDUNDANCY_FACTOR = 2
/** 压实触发：文件至少这么大才值得压，避免小文件反复重写 */
const COMPACT_MIN_BYTES = 2 * 1024 * 1024
/** 压实锁的过期时间：持锁进程崩溃后，超过这个时间的锁视为失效 */
const COMPACT_LOCK_STALE_MS = 60_000

/** 读 generation 时最多看这么多字节——首行只有几十字节 */
const HEADER_PROBE_BYTES = 256

type LogLine<E> =
  | { op: 'put'; e: E }
  | { op: 'del'; id: string }
  /** 首行：这一代文件的身份。压实换掉文件时换新值，读侧据此发现"我读的已经不是那个文件了" */
  | { op: 'head'; g: string }

/**
 * 带 id 的条目集合，落盘为追加日志。
 *
 * 线程/进程安全性：追加是单次小写入（O_APPEND 语义），多进程交错追加不会互相截断；
 * 这也是为什么不再需要"写前把整个索引读回来合并"那套防覆盖补丁。
 */
export class AgentIndexLog<E extends { id: string }> {
  private readonly filePath: string
  /** id → 最终态。null 表示尚未从磁盘装载 */
  private entryMap: Map<string, E> | null = null
  /** entries() 的派生数组，entryMap 变化时作废 */
  private entryArray: E[] | null = null
  /** 已消费到的字节偏移；文件只在尾部长，所以下次只需从这里往后读 */
  private readOffset = 0
  /** 日志里的物理行数（含被覆盖的旧版本与墓碑），用于判断该不该压实 */
  private lineCount = 0
  /** 已装载文件的 generation；与磁盘上的不一致说明文件被压实换过，偏移作废 */
  private generation: string | null = null
  /** 自己持有的压实锁标识；释放时据此确认删的是自己那把 */
  private lockToken: string | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  get path(): string {
    return this.filePath
  }

  /** 当前全部条目（顺序不保证；所有调用方都自行排序） */
  entries(): E[] {
    this.sync()
    if (!this.entryArray) {
      this.entryArray = [...this.entryMap!.values()]
    }
    return this.entryArray
  }

  /** 按 id 取单条。O(1)，不构造数组 */
  get(id: string): E | undefined {
    this.sync()
    return this.entryMap!.get(id)
  }

  size(): number {
    this.sync()
    return this.entryMap!.size
  }

  /** 磁盘上是否已有这份日志 */
  exists(): boolean {
    return fs.existsSync(this.filePath)
  }

  /** 写入或覆盖一条 */
  put(entry: E): void {
    this.sync()
    this.append({ op: 'put', e: entry })
    this.entryMap!.set(entry.id, entry)
    this.entryArray = null
    this.compactIfNeeded()
  }

  /** 写一条墓碑 */
  delete(id: string): void {
    this.sync()
    if (!this.entryMap!.has(id)) return
    this.append({ op: 'del', id })
    this.entryMap!.delete(id)
    this.entryArray = null
    this.compactIfNeeded()
  }

  /** 整体替换（重建索引、批量清理后使用），直接写成无冗余的紧凑日志 */
  replaceAll(entries: E[]): void {
    const map = new Map<string, E>()
    for (const entry of entries) map.set(entry.id, entry)
    this.writeCompact(map)
    this.entryMap = map
    this.entryArray = null
  }

  /**
   * 仅当日志还不存在时整体写入，返回是否由本次调用建立。
   *
   * 给"旧索引转日志"这类一次性初始化用：两个进程同时首启时，谁都以为自己该建，
   * 后建的会拿旧快照盖掉先建者期间已经追加的记录。持锁 + 复查把这个窗口关掉。
   */
  initializeIfAbsent(entries: E[]): boolean {
    if (this.exists()) return false
    if (!this.acquireCompactLock()) return false
    try {
      if (this.exists()) return false
      this.replaceAll(entries)
      return true
    } finally {
      this.releaseCompactLock()
    }
  }

  /** 丢弃内存态，下次访问重新从磁盘装载。供他进程改写后强制重读 */
  invalidate(): void {
    this.entryMap = null
    this.entryArray = null
    this.readOffset = 0
    this.lineCount = 0
    this.generation = null
  }

  // ==================== 内部 ====================

  /**
   * 把磁盘上的新增部分并进内存。
   *
   * 增量读的前提是"文件只在尾部长"，而压实会用一份新文件整个换掉它，这个前提就不成立了：
   * 换过之后旧偏移落在新文件的行中间，从那里读起会读出半行、把好数据当成损坏丢掉。
   * 所以复用偏移之前先核对 generation——不是同一代文件就整份重读。
   */
  private sync(): void {
    let fd: number
    try {
      // 全程用同一个 fd：它绑定的是具体那个文件，中途被压实换掉也不受影响。
      // 分开 stat / 读 header / 读内容的话，三者之间任何一个缝隙里发生压实，
      // 都会变成"拿着上一份文件的偏移去读下一份文件"，正好落在行中间。
      fd = fs.openSync(this.filePath, 'r')
    } catch {
      // 文件不存在：空集合，但保留已有内存态（可能是刚 replaceAll 还没落盘的极端情况）
      if (!this.entryMap) {
        this.entryMap = new Map()
        this.entryArray = null
        this.readOffset = 0
        this.lineCount = 0
        this.generation = null
      }
      return
    }

    try {
      const size = fs.fstatSync(fd).size
      const onDisk = this.readGenerationFrom(fd)
      const sameFile = this.entryMap !== null && onDisk !== null && onDisk === this.generation

      if (sameFile) {
        if (size === this.readOffset) return
        if (size > this.readOffset) {
          this.consume(fd, this.readOffset, size)
          return
        }
      }

      this.entryMap = new Map()
      this.entryArray = null
      this.readOffset = 0
      this.lineCount = 0
      this.generation = onDisk
      this.consume(fd, 0, size)
    } finally {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }

  /** 读首行拿 generation。文件为空或首行不是 header 时返回 null（退化为每次全量重读，安全但慢） */
  private readGenerationFrom(fd: number): string | null {
    try {
      const buf = Buffer.alloc(HEADER_PROBE_BYTES)
      const read = fs.readSync(fd, buf, 0, HEADER_PROBE_BYTES, 0)
      const text = buf.subarray(0, read).toString('utf-8')
      const end = text.indexOf('\n')
      if (end === -1) return null
      const parsed = JSON.parse(text.slice(0, end)) as LogLine<E>
      return parsed && parsed.op === 'head' ? parsed.g : null
    } catch {
      return null
    }
  }

  /** 文件当前的 generation（写路径用，不涉及偏移复用，可以单独开关一次） */
  private readGeneration(): string | null {
    let fd: number | undefined
    try {
      fd = fs.openSync(this.filePath, 'r')
      return this.readGenerationFrom(fd)
    } catch {
      return null
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  private newGeneration(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /** 空文件（或残缺得没有首行）时补上 header，让后续追加都属于同一代 */
  private ensureHeader(): void {
    if (this.readGeneration() !== null) return
    const g = this.newGeneration()
    let size = 0
    try { size = fs.statSync(this.filePath).size } catch { /* 不存在 */ }
    if (size > 0) {
      // 有内容却没有可识别的首行：这份文件的偏移无从谈起，重写成带 header 的紧凑形式
      this.sync()
      this.writeCompact(this.entryMap ?? new Map())
      return
    }
    try {
      // 'wx' 独占创建：两个进程同时初始化时只有一个能写成，另一个不会把对方的 header 截掉
      fs.writeFileSync(this.filePath, JSON.stringify({ op: 'head', g }) + '\n', { flag: 'wx' })
      this.generation = g
      this.readOffset = Buffer.byteLength(JSON.stringify({ op: 'head', g }) + '\n', 'utf-8')
      this.lineCount = 0
    } catch {
      // 别人抢先建好了，用他那份
      this.generation = this.readGeneration()
      this.readOffset = 0
    }
  }

  /** 从已打开的 fd 读 [from, to) 这一段并逐行合并 */
  private consume(fd: number, from: number, to: number): void {
    if (to <= from) return
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(to - from)
      const read = fs.readSync(fd, buffer, 0, to - from, from)
      if (read < buffer.length) buffer = buffer.subarray(0, read)
    } catch (e) {
      log.warn(`读取索引日志失败 (${path.basename(this.filePath)}):`, e)
      return
    }

    const text = buffer.toString('utf-8')
    // 末尾若不是完整行（写到一半崩溃，或他进程正在追加），停在最后一个换行处，
    // 剩下的半行留给下次；否则会把不完整的 JSON 当成损坏丢掉。
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak === -1) return
    const consumable = text.slice(0, lastBreak + 1)

    for (const line of consumable.split('\n')) {
      if (!line.trim()) continue
      let parsed: LogLine<E>
      try {
        parsed = JSON.parse(line) as LogLine<E>
      } catch {
        // 单行损坏不该毁掉整份索引：跳过它，其余照常。索引本就是可从正文重建的派生数据。
        log.warn(`索引日志有损坏行，已跳过 (${path.basename(this.filePath)})`)
        continue
      }
      // header 不是数据行，损坏行也不算——两者都不该计进压实判断
      if (parsed && parsed.op === 'put' && parsed.e && typeof parsed.e.id === 'string') {
        this.entryMap!.set(parsed.e.id, parsed.e)
        this.lineCount++
      } else if (parsed && parsed.op === 'del' && typeof parsed.id === 'string') {
        this.entryMap!.delete(parsed.id)
        this.lineCount++
      }
    }

    this.readOffset = from + Buffer.byteLength(consumable, 'utf-8')
    this.entryArray = null
  }

  private append(line: LogLine<E>): void {
    const text = JSON.stringify(line) + '\n'
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      this.ensureHeader()
      fs.appendFileSync(this.filePath, text)
      // 刻意不推进 readOffset：追加落在文件当时的末尾，而那个位置未必等于"我上次读到的
      // 位置 + 我这次写的字节数"——别的进程可能刚在中间插了几行。照后者记账，偏移就落到
      // 行中间去了，下次增量读会把好行读成半行。让下次读把自己这行一并读回来即可，
      // 同一条 put 重复应用是幂等的。
    } catch (e) {
      log.error(`追加索引日志失败 (${path.basename(this.filePath)}):`, e)
    }
  }

  /**
   * 冗余到一定程度就压实。
   *
   * 压实成本 O(N)，但两次压实之间必然发生了 N 次以上追加，摊销到每次追加仍是常数。
   * 拿不到锁（他进程正在压）就跳过——压实是纯优化，晚一轮没有任何影响。
   */
  private compactIfNeeded(): void {
    // 行数只由读侧统计（那是唯一能看到全部进程写入的地方），所以判断前先同步一次，
    // 否则自己刚追加的那些行还没算进来，判断会一直差一点
    this.sync()
    if (!this.entryMap) return
    const unique = this.entryMap.size
    if (this.lineCount < Math.max(unique, 1) * COMPACT_REDUNDANCY_FACTOR) return

    let size = 0
    try {
      size = fs.statSync(this.filePath).size
    } catch {
      return
    }
    if (size < COMPACT_MIN_BYTES) return

    const lock = this.acquireCompactLock()
    if (!lock) return
    try {
      // 持锁后再同步一次：内存态可能落后于磁盘（他进程刚写的还没并进来），
      // 拿旧内存态去压实等于把别人的条目抹掉
      this.sync()
      const before = this.lineCount
      this.writeCompact(this.entryMap!)
      log.info(`索引日志已压实 (${path.basename(this.filePath)})：${before} 行 → ${this.entryMap!.size} 条`)
    } finally {
      this.releaseCompactLock()
    }
  }

  /**
   * 把内存态写成无冗余的日志（临时文件 + rename，避免半截文件被读到）。
   *
   * 换文件的那一瞬间，另一个进程若刚好打开了旧文件准备追加，那一行会写进已被替换掉的
   * 旧文件里而丢失。窗口是 rename 的原子瞬间，且索引本就可从正文重建，故接受；换来的是
   * 追加路径完全不必加锁——那才是每轮工具调用都要走的热路径。
   */
  private writeCompact(map: Map<string, E>): void {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const g = this.newGeneration()
      const lines: string[] = [JSON.stringify({ op: 'head', g })]
      for (const entry of map.values()) {
        lines.push(JSON.stringify({ op: 'put', e: entry }))
      }
      const text = lines.join('\n') + '\n'
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, this.filePath)
      this.generation = g
      this.readOffset = Buffer.byteLength(text, 'utf-8')
      this.lineCount = lines.length - 1
    } catch (e) {
      log.error(`压实索引日志失败 (${path.basename(this.filePath)}):`, e)
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      // 压实失败不影响磁盘上已有的日志，作废偏移记账让下次整份重读即可。
      // 关键是**不能**把条目本身丢掉：调用方（put/delete/压实日志）在这之后还要接着用，
      // 置空会让它们踩到空引用，把一次"压实没成功"放大成保存记录失败。
      this.generation = null
      this.readOffset = 0
      this.lineCount = 0
    }
  }

  private get lockPath(): string {
    return `${this.filePath}.compact.lock`
  }

  /** 'wx' 独占创建即锁；持锁进程崩溃留下的陈旧锁按时间判定失效 */
  private acquireCompactLock(): boolean {
    const token = `${process.pid}:${this.newGeneration()}`
    try {
      fs.writeFileSync(this.lockPath, token, { flag: 'wx' })
      this.lockToken = token
      return true
    } catch {
      try {
        const age = Date.now() - fs.statSync(this.lockPath).mtimeMs
        if (age > COMPACT_LOCK_STALE_MS) {
          fs.unlinkSync(this.lockPath)
          fs.writeFileSync(this.lockPath, token, { flag: 'wx' })
          this.lockToken = token
          return true
        }
      } catch { /* 抢锁失败就跳过 */ }
      return false
    }
  }

  /**
   * 只删自己那把锁。
   *
   * 陈旧判定是时间启发式，慢盘上一次合法的长压实可能被别人判成"死了"而夺锁；
   * 无条件删就会把夺锁者刚建的锁一起删掉，于是第三个进程也进来压实。
   */
  private releaseCompactLock(): void {
    try {
      if (fs.readFileSync(this.lockPath, 'utf-8') === this.lockToken) {
        fs.unlinkSync(this.lockPath)
      }
    } catch { /* ignore */ }
    this.lockToken = null
  }
}
