/**
 * LanceDB 向量存储服务
 *
 * 运行模式：
 *   - Worker 模式（Electron 主进程）：通过 utilityProcess（lancedb-worker.js）
 *     代理所有 LanceDB 调用，把 Rust/C++ 原生模块隔离出主线程，消除
 *     Windows 首次启动时 LoadLibrary 阻塞导致 UI 卡死的问题。
 *   - In-process 模式（CLI / worker 启动失败）：直接在当前进程内运行 LanceDB，
 *     与旧版行为完全一致，用于命令行工具和测试。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import type {
  SearchOptions,
  SearchResult,
  KnowledgeStats
} from './types'
import { getBM25Index, type BM25SearchResult } from './bm25'
import { restoreBackup as doRestoreBackup } from './backup'
import { createLogger } from '../../utils/logger'
import { UtilityWorkerSession } from './worker-session'

const log = createLogger('KnowledgeStorage')

// LanceDB 记录类型
export interface VectorRecord {
  id: string
  docId: string
  content: string
  vector: number[]
  filename: string
  hostId: string
  tags: string  // 逗号分隔字符串（LanceDB 对空数组类型推断有问题）
  chunkIndex: number
  createdAt: number
}

// 兼容旧接口
export type OramaRecord = VectorRecord

// ────────────────────────── Worker 辅助函数 ──────────────────────────

function getWorkerScriptPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron')
    if (electronApp && electronApp.isPackaged) {
      return path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist-electron',
        'services',
        'knowledge',
        'lancedb-worker.js'
      )
    }
  } catch { /* 非 Electron 环境 */ }
  return path.join(process.cwd(), 'electron', 'services', 'knowledge', 'lancedb-worker.js')
}

function getUnpackedNodeModules(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app: electronApp } = require('electron')
    if (electronApp && electronApp.isPackaged) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    }
  } catch { /* 非 Electron 环境 */ }
  return path.join(process.cwd(), 'node_modules')
}

function detectUtilityProcessAvailable(): boolean {
  try {
    if ((process as any).type !== 'browser') return false
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    return !!(electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function')
  } catch {
    return false
  }
}

// ────────────────────────── In-process LanceDB 加载 ──────────────────────────

// 只在 in-process 降级路径下使用
let inProcLancedb: any = null

async function loadLanceDBInProc() {
  if (!inProcLancedb) {
    inProcLancedb = await import('@lancedb/lancedb')
  }
  return inProcLancedb
}

// 普通操作 2 分钟，全表扫描操作 5 分钟
const WORKER_TIMEOUT_MS = 2 * 60 * 1000
const WORKER_HEAVY_TIMEOUT_MS = 5 * 60 * 1000

// ────────────────────────── VectorStorage ──────────────────────────

export class VectorStorage extends EventEmitter {
  private storagePath: string
  private isInitialized: boolean = false
  private dimensions: number = 384

  // ── Worker 模式（Electron） ─────────────────────────────────────
  /** 当前在用的 worker 会话；换代时整体替换，旧会话自行清算，不共享请求队列 */
  private session: UtilityWorkerSession | null = null
  private workerReady: boolean = false

  // ── In-process 模式（CLI / worker 启动失败） ────────────────────
  private db: any = null
  private table: any = null
  private corruptionMarkerPath: string
  private deleteCount = 0
  private lastCompactTime = 0

  constructor() {
    super()
    this.storagePath = path.join(app.getPath('userData'), 'knowledge', 'lancedb')
    this.corruptionMarkerPath = path.join(this.storagePath, '.corrupted')
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true })
    }
  }

  // ────────────────────────── Worker 启停 / RPC ──────────────────────────

  private async startWorker(): Promise<void> {
    if (this.session?.isAlive) return

    const unpackedNM = getUnpackedNodeModules()
    const workerEnv: NodeJS.ProcessEnv = { ...process.env }
    workerEnv.NODE_PATH = workerEnv.NODE_PATH
      ? `${unpackedNM}${path.delimiter}${workerEnv.NODE_PATH}`
      : unpackedNM

    // 清掉「进程已退出但引用还在」的上一代残留，避免它的未完成请求悬着
    this.killWorker()

    const session = UtilityWorkerSession.spawn({
      scriptPath: getWorkerScriptPath(),
      env: workerEnv,
      label: 'LanceDB',
      defaultTimeoutMs: WORKER_TIMEOUT_MS,
      log
    })
    this.session = session

    session.onExit((code: number | null) => {
      log.info('LanceDB worker 退出，code=%s', code)
      // 只有退出的正是当前会话才清空引用：上一代的死讯不能抹掉新一代，
      // 否则新 worker 活着却再无人持有它，killWorker 也够不到。
      if (this.session === session) {
        this.session = null
        this.workerReady = false
      }
    })
  }

  private killWorker(): void {
    const session = this.session
    if (!session) return
    this.session = null
    this.workerReady = false
    session.kill()
  }

  private callWorker<T = any>(type: string, data?: any, timeoutMs = WORKER_TIMEOUT_MS): Promise<T> {
    const session = this.session
    if (!session?.isAlive) {
      return Promise.reject(new Error('LanceDB worker 未启动'))
    }
    return session.call<T>(type, data, timeoutMs)
  }

  // ────────────────────────── 初始化 ──────────────────────────

  async initialize(dimensions: number = 384): Promise<void> {
    if (this.isInitialized) return
    this.dimensions = dimensions

    // 启动 worker / in-process 之前，先尝试从备份恢复损坏的向量库。
    // 这样 worker 启动时磁盘已是恢复后的状态，不需要走 dropTable 重建路径；
    // 恢复失败则保留原状，让 worker 的兜底逻辑（dropTable + dataCorrupted 事件）处理。
    await this.tryRestoreFromBackupBeforeInit()

    if (detectUtilityProcessAvailable()) {
      try {
        await this.startWorker()
        const result = await this.callWorker<{
          ok: boolean
          events: Array<{ name: string; args: any[] }>
        }>('initialize', { storagePath: this.storagePath, dimensions })

        // 转发 worker 报告的事件（dimensionMismatch / dataCorrupted）
        for (const evt of result.events || []) {
          this.emit(evt.name, ...(evt.args || []))
        }

        this.workerReady = true
        this.isInitialized = true
        this.emit('initialized')
        log.info('LanceDB 已在 worker 进程中初始化（维度=%d）', dimensions)
        return
      } catch (error) {
        this.killWorker()
        const detail = error instanceof Error ? error.message : String(error)
        const err = new Error(
          `LanceDB worker 初始化失败（禁止回退主进程）：${detail}。` +
            `若为打包版，请检查 asarUnpack 是否包含 apache-arrow / reflect-metadata / tslib / flatbuffers。`,
        )
        log.error(err.message, error)
        throw err
      }
    }

    // CLI / shim：utilityProcess 不可用，进程内是唯一模式
    await this.initializeInProcess(dimensions)
  }

  /**
   * 启动前检查 .corrupted 标记：有标记则尝试从最近备份恢复。
   * 恢复成功后删除标记，worker 启动时就不会触发 dropTable。
   * 恢复失败保留标记，worker 兜底逻辑会清表并触发全量重建。
   *
   * 注意：这里只能恢复「上一次运行结束时被标记为损坏」的情况——
   * 运行期被标记的损坏（如 hybridSearch 报 IO 错）需要下次启动才生效。
   */
  private async tryRestoreFromBackupBeforeInit(): Promise<void> {
    if (!fs.existsSync(this.corruptionMarkerPath)) return

    let reason = 'unknown'
    try {
      const data = JSON.parse(fs.readFileSync(this.corruptionMarkerPath, 'utf-8'))
      reason = data?.reason || reason
    } catch { /* ignore */ }

    log.warn(`检测到损坏标记 (${reason})，尝试从备份恢复...`)

    try {
      const result = doRestoreBackup()
      if (result.success) {
        log.info(`从备份恢复成功: ${result.backupPath}，删除损坏标记`)
        try { fs.unlinkSync(this.corruptionMarkerPath) } catch { /* ignore */ }
        this.emit('restoredFromBackup', { backupPath: result.backupPath, reason })
      } else {
        log.warn(`从备份恢复失败: ${result.error}，将走清表重建路径`)
      }
    } catch (e) {
      log.warn('调用 restoreBackup 异常，将走清表重建路径:', e)
    }
  }

  // ────────────────────────── In-process helpers ──────────────────────────

  private markCorrupted(reason: string): void {
    try {
      fs.writeFileSync(
        this.corruptionMarkerPath,
        JSON.stringify({ reason, at: Date.now() }),
        'utf-8'
      )
      log.warn('已标记向量表为损坏，将在下次启动时重建:', reason)
    } catch (e) {
      log.warn('写入损坏标记失败:', e)
    }
  }

  private consumeCorruptionMarker(): { corrupted: boolean; reason?: string } {
    if (!fs.existsSync(this.corruptionMarkerPath)) return { corrupted: false }
    let reason: string | undefined
    try {
      const data = JSON.parse(fs.readFileSync(this.corruptionMarkerPath, 'utf-8'))
      reason = data?.reason
    } catch { /* ignore */ }
    try { fs.unlinkSync(this.corruptionMarkerPath) } catch { /* ignore */ }
    return { corrupted: true, reason }
  }

  private isLanceCorruptionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error || '')
    if (!msg) return false
    return msg.includes('LanceError(IO)') && msg.includes('Not found')
  }

  private async ensureTableInProc(sampleRecord?: VectorRecord): Promise<void> {
    if (this.table) return

    try {
      const names = await this.db.tableNames()
      if (names.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')
        return
      }
    } catch (e) {
      log.warn('检查表是否存在失败，继续尝试创建:', e)
    }

    const isPlaceholder = !sampleRecord
    const recordToInsert: VectorRecord = sampleRecord ?? {
      id: '__init__',
      docId: '__init__',
      content: '',
      vector: new Array(this.dimensions).fill(0),
      filename: '',
      hostId: '',
      tags: '',
      chunkIndex: 0,
      createdAt: Date.now()
    }

    try {
      this.table = await this.db.createTable('knowledge_vectors', [recordToInsert])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('already exists')) {
        log.warn('createTable 冲突（磁盘残留表），fallback 到 openTable')
        this.table = await this.db.openTable('knowledge_vectors')
        return
      }
      throw error
    }

    if (isPlaceholder) {
      await this.table.delete('"id" = \'__init__\'')
    }
  }

  private async compactInProc(aggressive: boolean = false): Promise<void> {
    if (!this.table || !this.db) return
    try {
      if (typeof this.table.optimize === 'function') {
        await this.table.optimize(aggressive ? { cleanupOlderThan: new Date() } : undefined)
      } else if (typeof this.table.cleanup === 'function') {
        await this.table.cleanup()
      } else if (typeof this.table.compaction === 'function') {
        await this.table.compaction()
      }
      const names = await this.db.tableNames()
      if (names.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')
      }
    } catch (error) {
      log.error('Compact failed:', error)
    }
  }

  private async initializeInProcess(dimensions: number): Promise<void> {
    try {
      const { connect } = await loadLanceDBInProc()
      this.db = await connect(this.storagePath)

      const events: Array<{ name: string; args: any[] }> = []

      const corruption = this.consumeCorruptionMarker()
      if (corruption.corrupted) {
        log.warn('启动时检测到向量表损坏标记，将清空并重建:', corruption.reason)
        try {
          const names = await this.db.tableNames()
          if (names.includes('knowledge_vectors')) {
            await this.db.dropTable('knowledge_vectors')
          }
        } catch (e) {
          log.warn('清理损坏向量表失败:', e)
        }
        this.table = null
        events.push({ name: 'dataCorrupted', args: [] })
      }

      const tableNames = await this.db.tableNames()
      if (tableNames.includes('knowledge_vectors')) {
        this.table = await this.db.openTable('knowledge_vectors')

        // 检查维度
        const mismatch = await this.checkDimensionMismatchInProc(dimensions)
        if (mismatch === 'DATA_CORRUPTED') {
          events.push({ name: 'dataCorrupted', args: [] })
        } else if (mismatch !== null) {
          log.info(`检测到向量维度变化 (${mismatch} -> ${dimensions})，自动清空旧索引...`)
          await this.db.dropTable('knowledge_vectors')
          this.table = null
          events.push({ name: 'dimensionMismatch', args: [{ old: mismatch, new: dimensions }] })
        }
      } else {
        this.table = null
      }

      for (const evt of events) {
        this.emit(evt.name, ...(evt.args || []))
      }

      this.isInitialized = true
      this.emit('initialized')
      log.info('LanceDB 在主进程内初始化完成（维度=%d，降级模式）', dimensions)
    } catch (error) {
      log.error('In-process LanceDB 初始化失败:', error)
      throw error
    }
  }

  private async checkDimensionMismatchInProc(expectedDimensions: number): Promise<number | 'DATA_CORRUPTED' | null> {
    if (!this.table) return null
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sample = await this.table.query().limit(1).toArray()
        if (sample.length === 0) return null
        const vectorLength = sample[0].vector?.length
        if (vectorLength && vectorLength !== expectedDimensions) return vectorLength
        return null
      } catch (error) {
        log.warn(`维度检查第 ${attempt}/${maxRetries} 次查询失败:`, error)
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
    log.warn('LanceDB 表数据无法读取，清空损坏的表（非模型升级）')
    try { await this.db.dropTable('knowledge_vectors') } catch (e) { log.warn('清空损坏表失败:', e) }
    this.table = null
    this.emit('dataCorrupted')
    return 'DATA_CORRUPTED'
  }

  // ────────────────────────── 公开 API（写操作） ──────────────────────────

  async addRecord(record: VectorRecord): Promise<string> {
    if (this.workerReady) {
      const { id } = await this.callWorker<{ id: string }>('addRecord', { record })
      this.emit('recordAdded', id)
      return id
    }
    if (!this.db) throw new Error('数据库未初始化')
    await this.ensureTableInProc(record)
    await this.table.add([record])
    this.emit('recordAdded', record.id)
    return record.id
  }

  async addRecords(records: VectorRecord[]): Promise<string[]> {
    if (records.length === 0) return []
    if (this.workerReady) {
      const { ids } = await this.callWorker<{ ids: string[] }>('addRecords', { records })
      this.emit('recordsAdded', ids)
      return ids
    }
    if (!this.db) throw new Error('数据库未初始化')
    await this.ensureTableInProc(records[0])
    await this.table!.add(records)
    const ids = records.map(r => r.id)
    this.emit('recordsAdded', ids)
    return ids
  }

  async removeRecord(id: string): Promise<boolean> {
    if (this.workerReady) {
      const { removed } = await this.callWorker<{ removed: boolean }>('removeRecord', { id })
      if (removed) this.emit('recordRemoved', id)
      return removed
    }
    if (!this.table) return false
    try {
      await this.table.delete(`"id" = '${id}'`)
      this.emit('recordRemoved', id)
      return true
    } catch {
      return false
    }
  }

  async removeDocumentChunks(docId: string, forceCompact: boolean = false): Promise<number> {
    if (this.workerReady) {
      const { count } = await this.callWorker<{ count: number }>(
        'removeDocumentChunks', { docId, forceCompact }
      )
      if (count > 0) this.emit('documentRemoved', { docId, chunksRemoved: count })
      return count
    }
    if (!this.table) return 0
    try {
      const beforeCount = await this.table.countRows()
      await this.table.delete(`"docId" = '${docId}'`)
      const afterCount = await this.table.countRows()
      const removed = beforeCount - afterCount

      if (removed > 0) {
        this.emit('documentRemoved', { docId, chunksRemoved: removed })
        this.deleteCount++
        if (forceCompact) {
          await this.compactInProc()
          this.deleteCount = 0
          this.lastCompactTime = Date.now()
        } else {
          this.compactIfNeededInProc().catch(e => log.warn('Compact failed:', e))
        }
      }
      return removed
    } catch (error) {
      log.error('Failed to remove chunks:', error)
      return 0
    }
  }

  private async compactIfNeededInProc(): Promise<void> {
    const now = Date.now()
    if (this.deleteCount >= 10 || (now - this.lastCompactTime) > 5 * 60 * 1000) {
      await this.compactInProc()
      this.deleteCount = 0
      this.lastCompactTime = now
    }
  }

  /** 删除文档的所有记录（别名） */
  async removeRecordsByDocId(docId: string): Promise<number> {
    return this.removeDocumentChunks(docId)
  }

  async compact(aggressive: boolean = false): Promise<void> {
    if (this.workerReady) {
      await this.callWorker('compact', { aggressive })
      return
    }
    await this.compactInProc(aggressive)
  }

  async clear(): Promise<void> {
    if (this.workerReady) {
      await this.callWorker('dropTable')
    } else {
      if (this.table && this.db) {
        await this.db.dropTable('knowledge_vectors')
        this.table = null
      }
    }

    // fs.rmSync 在主进程执行（worker 进程的文件句柄在 dropTable 后已释放）
    const tablePath = path.join(this.storagePath, 'knowledge_vectors.lance')
    if (fs.existsSync(tablePath)) {
      fs.rmSync(tablePath, { recursive: true, force: true })
      log.info('已删除 LanceDB 数据目录:', tablePath)
    }

    if (!this.workerReady) this.deleteCount = 0
    this.emit('cleared')
  }

  // ────────────────────────── 公开 API（读操作） ──────────────────────────

  async searchByVector(
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10

    if (this.workerReady) {
      const { hits } = await this.callWorker<{ hits: any[] }>(
        'vectorSearch', { embedding, limit: limit * 2 }
      )
      return this.formatResults(hits, options)
    }

    if (!this.table) return []
    try {
      const results = await this.table
        .vectorSearch(embedding)
        .distanceType('cosine')
        .limit(limit * 2)
        .toArray()
      return this.formatResults(results, options)
    } catch (error) {
      log.error('Vector search failed:', error)
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`searchByVector: ${(error as Error).message}`)
      }
      return []
    }
  }

  /** @deprecated LanceDB 没有内置全文搜索，请使用 hybridSearch */
  async searchByText(
    _query: string,
    _options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    log.warn('searchByText requires embedding, use hybridSearch instead')
    return []
  }

  async hybridSearch(
    query: string,
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const k = 60  // RRF 参数，经验最优值

    try {
      // 1. 向量搜索（worker 或 in-process）
      let vectorResults: SearchResult[] = []
      if (this.workerReady) {
        const { hits } = await this.callWorker<{ hits: any[] }>(
          'vectorSearch', { embedding, limit: limit * 2 }
        )
        vectorResults = this.formatResults(hits, options)
      } else if (this.table) {
        const vectorHits = await this.table
          .vectorSearch(embedding)
          .distanceType('cosine')
          .limit(limit * 2)
          .toArray()
        vectorResults = this.formatResults(vectorHits, options)
      }

      // 2. BM25 搜索（始终在主进程执行，与 LanceDB 无关）
      const bm25Index = getBM25Index()
      let bm25Results: BM25SearchResult[] = []
      if (bm25Index.isReady()) {
        bm25Results = await bm25Index.search(query, limit * 2, {
          hostId: options.hostId,
          tags: options.tags
        })
      }

      // 3. RRF 融合
      return this.rrfFusion(vectorResults, bm25Results, k).slice(0, limit)
    } catch (error) {
      log.error('Hybrid search failed:', error)
      if (!this.workerReady && this.isLanceCorruptionError(error)) {
        this.markCorrupted(`hybridSearch: ${(error as Error).message}`)
      }
      return []
    }
  }

  async getRecordsByDocId(docId: string): Promise<VectorRecord[]> {
    if (this.workerReady) {
      const { records } = await this.callWorker<{ records: VectorRecord[] }>(
        'getRecordsByDocId', { docId }, WORKER_HEAVY_TIMEOUT_MS
      )
      return records
    }
    if (!this.table) return []
    try {
      const allRows = await this.table.query().toArray()
      return (allRows as VectorRecord[]).filter(r => r.docId === docId)
    } catch (error) {
      log.error('Failed to get records by docId:', error)
      return []
    }
  }

  async getRecordsByDocIds(docIds: Set<string>): Promise<Map<string, VectorRecord>> {
    if (this.workerReady) {
      const { records } = await this.callWorker<{ records: [string, VectorRecord][] }>(
        'getRecordsByDocIds', { docIds: Array.from(docIds) }, WORKER_HEAVY_TIMEOUT_MS
      )
      return new Map(records)
    }
    if (!this.table || docIds.size === 0) return new Map()
    try {
      const allRows = await this.table.query().toArray()
      const result = new Map<string, VectorRecord>()
      for (const row of allRows as VectorRecord[]) {
        if (docIds.has(row.docId) && !result.has(row.docId)) {
          result.set(row.docId, row)
        }
      }
      return result
    } catch (error) {
      log.error('Failed to get records by docIds:', error)
      return new Map()
    }
  }

  async getStats(): Promise<KnowledgeStats> {
    if (this.workerReady) {
      const { stats } = await this.callWorker<{ stats: KnowledgeStats }>('getStats')
      return stats
    }
    if (!this.table) {
      return { documentCount: 0, chunkCount: 0, totalSize: 0 }
    }
    try {
      const chunkCount = await this.table.countRows()
      const allRows = await this.table.query().select(['docId']).toArray()
      const uniqueDocIds = new Set(allRows.map((r: any) => r.docId))
      return { documentCount: uniqueDocIds.size, chunkCount, totalSize: 0, lastUpdated: Date.now() }
    } catch (error) {
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getStats: ${(error as Error).message}`)
      }
      return { documentCount: 0, chunkCount: 0, totalSize: 0 }
    }
  }

  async getValidRecords(validDocIds: Set<string>): Promise<VectorRecord[]> {
    if (this.workerReady) {
      const { records } = await this.callWorker<{ records: VectorRecord[] }>(
        'getValidRecords', { docIds: Array.from(validDocIds) }, WORKER_HEAVY_TIMEOUT_MS
      )
      return records
    }
    if (!this.table || validDocIds.size === 0) return []
    try {
      const allRows = await this.table.query().toArray()
      return (allRows as any[])
        .filter(r => validDocIds.has(r.docId))
        .map(r => ({
          id: r.id,
          docId: r.docId,
          content: r.content,
          vector: Array.from(r.vector as Iterable<number>),
          filename: r.filename,
          hostId: r.hostId,
          tags: r.tags,
          chunkIndex: r.chunkIndex,
          createdAt: r.createdAt
        }))
    } catch (error) {
      log.error('Failed to get valid records:', error)
      return []
    }
  }

  async getChunkCount(): Promise<number> {
    if (this.workerReady) {
      try {
        const { count } = await this.callWorker<{ count: number }>('getChunkCount')
        return count ?? 0
      } catch (error) {
        log.warn('getChunkCount via worker failed:', error)
        return 0
      }
    }
    if (!this.table) return 0
    try {
      return await this.table.countRows()
    } catch (error) {
      log.warn('getChunkCount failed:', error)
      return 0
    }
  }

  async getAllDocIds(): Promise<Set<string>> {
    if (this.workerReady) {
      const { docIds } = await this.callWorker<{ docIds: string[] }>(
        'getAllDocIds', undefined, WORKER_HEAVY_TIMEOUT_MS
      )
      return new Set(docIds)
    }
    if (!this.table) return new Set()
    try {
      const allRows = await this.table.query().select(['docId']).toArray()
      const docIds = new Set<string>()
      for (const row of allRows) {
        if ((row as any).docId) docIds.add((row as any).docId)
      }
      return docIds
    } catch (error) {
      log.error('Failed to get all docIds:', error)
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getAllDocIds: ${(error as Error).message}`)
      }
      return new Set()
    }
  }

  // ────────────────────────── 状态查询 ──────────────────────────

  isReady(): boolean {
    return this.isInitialized && (this.workerReady || this.db !== null)
  }

  getStoragePath(): string {
    return this.storagePath
  }

  /**
   * 强制重新初始化：用于从备份恢复后，丢弃内存中的 worker / db 句柄，
   * 下次 initialize() 会重新连接磁盘上恢复后的数据。
   */
  async forceReinitialize(): Promise<void> {
    try {
      await this.disposeAsync(1000)
    } catch (e) {
      log.warn('forceReinitialize: disposeAsync 失败:', e)
    }
    this.isInitialized = false
    this.workerReady = false
    this.db = null
    this.table = null
  }

  /**
   * 优雅释放 LanceDB worker：先 compact 落盘，再结束子进程。
   * 供主进程 quit / SIGTERM 路径调用，降低 transaction 半截退出导致损坏的概率。
   */
  async disposeAsync(timeoutMs: number = 500): Promise<void> {
    try {
      if (this.workerReady) {
        await this.callWorker('compact', { aggressive: false }, timeoutMs).catch(err => {
          log.warn('LanceDB dispose compact 失败或超时:', err)
        })
      } else if (this.table) {
        await this.compactInProc()
      }
    } finally {
      this.killWorker()
      this.isInitialized = false
    }
  }

  // ────────────────────────── 搜索结果处理（本地纯计算） ──────────────────────────

  private formatResults(
    hits: any[],
    options: Partial<SearchOptions>
  ): SearchResult[] {
    const similarityThreshold = options.similarity || 0.3

    let results: SearchResult[] = hits.map(hit => ({
      id: hit.id,
      docId: hit.docId,
      content: hit.content,
      score: hit._distance ? 1 - hit._distance : 1,
      metadata: {
        filename: hit.filename,
        hostId: hit.hostId || '',
        tags: hit.tags ? hit.tags.split(',').filter((t: string) => t) : [],
        startOffset: 0,
        endOffset: hit.content?.length || 0
      },
      source: 'local' as const
    }))

    results = results.filter(r => r.score >= similarityThreshold)

    if (options.hostId && options.hostId.trim()) {
      results = results.filter(r => !r.metadata.hostId || r.metadata.hostId === options.hostId)
    }

    if (options.tags && options.tags.length > 0) {
      results = results.filter(r =>
        options.tags!.some(tag => r.metadata.tags.includes(tag))
      )
    }

    return results.slice(0, options.limit || 10)
  }

  private rrfFusion(
    vectorResults: SearchResult[],
    bm25Results: BM25SearchResult[],
    k: number = 60
  ): SearchResult[] {
    const scoreMap = new Map<string, { score: number; result: SearchResult }>()

    vectorResults.forEach((result, rank) => {
      scoreMap.set(result.id, { score: 1 / (k + rank + 1), result })
    })

    bm25Results.forEach((bm25Result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      if (scoreMap.has(bm25Result.id)) {
        scoreMap.get(bm25Result.id)!.score += rrfScore
      } else {
        scoreMap.set(bm25Result.id, {
          score: rrfScore,
          result: {
            id: bm25Result.id,
            docId: bm25Result.docId,
            content: bm25Result.content,
            score: bm25Result.score,
            metadata: {
              filename: bm25Result.filename,
              hostId: bm25Result.hostId || '',
              tags: bm25Result.tags ? bm25Result.tags.split(',').filter(t => t) : [],
              startOffset: 0,
              endOffset: bm25Result.content?.length || 0
            },
            source: 'local' as const
          }
        })
      }
    })

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ score, result }) => ({ ...result, score }))
  }
}

// ────────────────────────── 单例 ──────────────────────────

let vectorStorage: VectorStorage | null = null

export function getVectorStorage(): VectorStorage {
  if (!vectorStorage) {
    vectorStorage = new VectorStorage()
  }
  return vectorStorage
}
