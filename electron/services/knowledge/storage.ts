/**
 * LanceDB 向量存储服务
 * 提供向量存储和语义搜索功能
 * 支持 BM25 + 向量混合搜索 (RRF 融合)
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
import { createLogger } from '../../utils/logger'

const log = createLogger('KnowledgeStorage')

// LanceDB 记录类型
export interface VectorRecord {
  id: string
  docId: string
  content: string
  vector: number[]
  filename: string
  hostId: string
  tags: string  // 改为字符串，用逗号分隔（LanceDB 对空数组类型推断有问题）
  chunkIndex: number
  createdAt: number
}

// 兼容旧接口
export type OramaRecord = VectorRecord

// 动态导入 LanceDB
let lancedb: any = null

async function loadLanceDB() {
  if (!lancedb) {
    lancedb = await import('@lancedb/lancedb')
  }
  return lancedb
}

export class VectorStorage extends EventEmitter {
  private db: any = null
  private table: any = null
  private storagePath: string
  private tableName = 'knowledge_vectors'
  private corruptionMarkerPath: string
  private isInitialized: boolean = false
  private dimensions: number = 384

  constructor() {
    super()
    this.storagePath = path.join(app.getPath('userData'), 'knowledge', 'lancedb')
    // 损坏标记：search 路径检测到 LanceError(IO): Not found 等不可恢复
    // IO 错误时写入；下次启动时强制 dropTable 重建。运行期不做实时重建是
    // 因为重建需要重新跑 embedding（耗时且可能短暂阻塞用户搜索）。
    this.corruptionMarkerPath = path.join(this.storagePath, '.corrupted')
    this.ensureDirectories()
  }

  /**
   * 确保存储目录存在
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true })
    }
  }

  /**
   * 标记向量表为损坏，下次启动时强制重建。
   * 在运行期对损坏的 LanceDB 不会强行 dropTable —— search 报错可能是瞬态
   * 文件锁/缓存问题，盲目 drop 会丢失未受影响的数据。
   */
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

  /**
   * 检查是否存在损坏标记并清理（initialize 调用）
   */
  private consumeCorruptionMarker(): { corrupted: boolean; reason?: string } {
    if (!fs.existsSync(this.corruptionMarkerPath)) {
      return { corrupted: false }
    }
    let reason: string | undefined
    try {
      const data = JSON.parse(fs.readFileSync(this.corruptionMarkerPath, 'utf-8'))
      reason = data?.reason
    } catch { /* ignore */ }
    try {
      fs.unlinkSync(this.corruptionMarkerPath)
    } catch { /* ignore */ }
    return { corrupted: true, reason }
  }

  /**
   * 判断错误是否属于"LanceDB 不可恢复的物理损坏"
   *
   * 关键模式（ripgrep 自实测见过的字面错误）：
   *   - "Not found: …knowledge_vectors.lance/data/…lance"（manifest 引用了不存在的 data 文件）
   *   - "LanceError(IO)" 包裹的 IO 错误
   * 不匹配关键词不进入自愈路径，避免把瞬态错误误判成损坏。
   */
  private isLanceCorruptionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error || '')
    if (!msg) return false
    // 必须同时命中 IO 类别 + Not found，避免误伤超时/连接类瞬态错误
    return msg.includes('LanceError(IO)') && msg.includes('Not found')
  }

  /**
   * 初始化数据库
   */
  async initialize(dimensions: number = 384): Promise<void> {
    if (this.isInitialized) {
      return
    }

    this.dimensions = dimensions

    try {
      const { connect } = await loadLanceDB()

      this.db = await connect(this.storagePath)

      // 优先消费上次运行期写入的"损坏标记"
      // 这是 hybridSearch 等读路径在遇到 LanceError(IO): Not found: …lance
      // 时留下的"下次启动请重建"提示。命中后直接 dropTable，让后续走和
      // dimensionMismatch 一样的"清空 + 重建索引"路径，避免损坏状态延续。
      const corruption = this.consumeCorruptionMarker()
      if (corruption.corrupted) {
        log.warn('启动时检测到向量表损坏标记，将清空并重建:', corruption.reason)
        try {
          const tableNames = await this.db.tableNames()
          if (tableNames.includes(this.tableName)) {
            await this.db.dropTable(this.tableName)
          }
        } catch (e) {
          log.warn('清理损坏向量表失败（继续走重建流程）:', e)
        }
        this.table = null
        // 复用现有 dataCorrupted 事件链路：知识库主服务监听后会同步清空 BM25
        this.emit('dataCorrupted')
      }

      // 检查表是否存在
      const tableNames = await this.db.tableNames()

      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName)

        // 检查现有数据的向量维度是否匹配
        const dimensionMismatch = await this.checkDimensionMismatch(dimensions)
        if (dimensionMismatch) {
          log.info(`检测到向量维度变化 (${dimensionMismatch} -> ${dimensions})，自动清空旧索引...`)
          await this.db.dropTable(this.tableName)
          this.table = null
          this.emit('dimensionMismatch', { old: dimensionMismatch, new: dimensions })
        }
      } else {
        // 创建空表（LanceDB 需要至少一条数据来推断 schema）
        // 我们在第一次添加记录时创建表
        this.table = null
      }

      this.isInitialized = true
      this.emit('initialized')
    } catch (error) {
      log.error('Initialization failed:', error)
      throw error
    }
  }

  /**
   * 检查现有数据的向量维度是否与期望维度不匹配
   * @returns 如果不匹配返回旧维度，匹配返回 null
   */
  private async checkDimensionMismatch(expectedDimensions: number): Promise<number | null> {
    if (!this.table) return null
    
    // 带重试的查询，LanceDB 在 manifest 过多时首次查询可能失败
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sample = await this.table.query().limit(1).toArray()
        if (sample.length === 0) return null
        
        const vectorLength = sample[0].vector?.length
        if (vectorLength && vectorLength !== expectedDimensions) {
          return vectorLength
        }
        return null
      } catch (error) {
        log.warn(`维度检查第 ${attempt}/${maxRetries} 次查询失败:`, error)
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 500 * attempt))
        }
      }
    }

    // 所有重试都失败：数据可能损坏，清空表但不报告为维度变化
    log.warn('LanceDB 表数据无法读取，清空损坏的表（非模型升级）')
    try {
      await this.db.dropTable(this.tableName)
    } catch (e) {
      log.warn('清空损坏表失败:', e)
    }
    this.table = null
    this.emit('dataCorrupted')
    // 返回 null：不触发 dimensionMismatch 事件，后续 checkAndRebuildIndex 会静默重建
    return null
  }

  /**
   * 确保表存在
   *
   * 处理三种情况：
   * 1. 内存里 this.table 已存在：直接返回
   * 2. 磁盘上表已存在（tableNames 包含）：openTable 打开
   * 3. 表不存在：createTable 创建
   *
   * createTable 抛 "already exists" 时 fallback 到 openTable，
   * 防止磁盘残留（如 dropTable 失败）导致反复 createTable 刷屏。
   */
  private async ensureTable(sampleRecord?: VectorRecord): Promise<void> {
    if (this.table) return

    try {
      const tableNames = await this.db.tableNames()
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName)
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
      this.table = await this.db.createTable(this.tableName, [recordToInsert])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('already exists')) {
        log.warn(`createTable 冲突（磁盘残留表），fallback 到 openTable: ${msg}`)
        this.table = await this.db.openTable(this.tableName)
        // openTable 成功后由调用方继续 add 新记录；不要再插入 __init__ 占位数据
        return
      }
      throw error
    }

    if (isPlaceholder) {
      // 使用双引号包裹列名，防止 DataFusion SQL 解析器将其转为小写
      await this.table.delete('"id" = \'__init__\'')
    }
  }

  /**
   * 添加记录
   */
  async addRecord(record: VectorRecord): Promise<string> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    await this.ensureTable(record)
    await this.table.add([record])
    
    this.emit('recordAdded', record.id)
    return record.id
  }

  /**
   * 批量添加记录
   */
  async addRecords(records: VectorRecord[]): Promise<string[]> {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }

    if (records.length === 0) return []

    await this.ensureTable(records[0])
    await this.table!.add(records)
    
    const ids = records.map(r => r.id)
    this.emit('recordsAdded', ids)
    return ids
  }

  /**
   * 删除记录
   */
  async removeRecord(id: string): Promise<boolean> {
    if (!this.table) return false

    try {
      // 使用双引号包裹列名，防止 DataFusion SQL 解析器将其转为小写
      await this.table.delete(`"id" = '${id}'`)
      this.emit('recordRemoved', id)
      return true
    } catch {
      return false
    }
  }

  /**
   * 删除文档的所有分块
   * @param forceCompact 是否强制执行 compact（批量删除最后一个时应该传 true）
   */
  async removeDocumentChunks(docId: string, forceCompact: boolean = false): Promise<number> {
    if (!this.table) return 0

    try {
      const beforeCount = await this.table.countRows()
      // 使用双引号包裹列名，防止 DataFusion SQL 解析器将其转为小写
      await this.table.delete(`"docId" = '${docId}'`)
      const afterCount = await this.table.countRows()
      const removed = beforeCount - afterCount
      
      if (removed > 0) {
        this.emit('documentRemoved', { docId, chunksRemoved: removed })
        this.deleteCount++
        
        // 强制 compact 或按需 compact
        if (forceCompact) {
          await this.compact()
          this.deleteCount = 0
          this.lastCompactTime = Date.now()
        } else {
          // 执行 compact 操作清理已删除的数据（异步，不阻塞）
          this.compactIfNeeded().catch(e => {
            log.warn('Compact failed:', e)
          })
        }
      }
      
      return removed
    } catch (error) {
      log.error('Failed to remove chunks:', error)
      return 0
    }
  }

  // 记录删除操作计数，用于决定何时 compact
  private deleteCount = 0
  private lastCompactTime = 0

  /**
   * 按需执行 compact 操作
   * 每删除 10 个文档或距离上次 compact 超过 5 分钟时执行
   */
  private async compactIfNeeded(): Promise<void> {
    const now = Date.now()
    const timeSinceLastCompact = now - this.lastCompactTime

    // 每删除 10 个文档或超过 5 分钟执行一次 compact
    if (this.deleteCount >= 10 || timeSinceLastCompact > 5 * 60 * 1000) {
      await this.compact()
      this.deleteCount = 0
      this.lastCompactTime = now
    }
  }

  /**
   * 执行 compact 操作，清理已删除的数据释放磁盘空间
   * @param aggressive 是否立即清理所有旧版本（默认保留 7 天）
   */
  async compact(aggressive: boolean = false): Promise<void> {
    if (!this.table || !this.db) return

    try {
      if (typeof this.table.optimize === 'function') {
        const options = aggressive
          ? { cleanupOlderThan: new Date() }
          : undefined
        await this.table.optimize(options)
        log.info(`Compact (optimize${aggressive ? ', aggressive' : ''}) completed`)
      } else if (typeof this.table.cleanup === 'function') {
        await this.table.cleanup()
        log.info('Compact (cleanup) completed')
      } else if (typeof this.table.compaction === 'function') {
        await this.table.compaction()
        log.info('Compact (compaction) completed')
      } else {
        log.warn('No compact method available, will rely on delete')
      }
      
      // 重新打开表以刷新缓存（确保删除的数据不会被缓存返回）
      const tableNames = await this.db.tableNames()
      if (tableNames.includes(this.tableName)) {
        this.table = await this.db.openTable(this.tableName)
        log.info('Table reopened to refresh cache')
      }
    } catch (error) {
      log.error('Compact failed:', error)
    }
  }

  /**
   * 获取文档的所有记录
   */
  async getRecordsByDocId(docId: string): Promise<VectorRecord[]> {
    if (!this.table) return []

    try {
      // LanceDB 查询：使用 query() 方法获取所有行，然后过滤
      const allRows = await this.table.query().toArray()
      const filtered = (allRows as VectorRecord[]).filter(r => r.docId === docId)
      return filtered
    } catch (error) {
      log.error('Failed to get records by docId:', error)
      return []
    }
  }

  /**
   * 批量获取多个文档的向量记录
   * 一次全表查询，按 docId 过滤，避免 N+1 查询问题
   */
  async getRecordsByDocIds(docIds: Set<string>): Promise<Map<string, VectorRecord>> {
    if (!this.table || docIds.size === 0) return new Map()

    try {
      const allRows = await this.table.query().toArray()
      const result = new Map<string, VectorRecord>()
      for (const row of allRows as VectorRecord[]) {
        // 每个 docId 只取第一条（主机记忆通常只有一个 chunk）
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

  /**
   * 删除文档的所有记录（别名，与 removeDocumentChunks 相同）
   */
  async removeRecordsByDocId(docId: string): Promise<number> {
    return this.removeDocumentChunks(docId)
  }

  /**
   * 向量搜索
   */
  async searchByVector(
    embedding: number[], 
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    if (!this.table) {
      return []
    }

    const limit = options.limit || 10

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

  /**
   * 全文搜索（基于向量相似度）
   * LanceDB 原生支持中文，无需分词
   */
  async searchByText(
    _query: string, 
    _options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    // LanceDB 没有内置全文搜索，使用向量搜索
    // 调用方需要先将 query 转为 embedding
    log.warn('searchByText requires embedding, use hybridSearch instead')
    return []
  }

  /**
   * 混合搜索（BM25 + 向量搜索 + RRF 融合）
   */
  async hybridSearch(
    query: string,
    embedding: number[],
    options: Partial<SearchOptions> = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10
    const k = 60  // RRF 参数，经验最优值

    try {
      // 1. 向量搜索（使用余弦距离，_distance = 1 - cosine_sim）
      let vectorResults: SearchResult[] = []
      if (this.table) {
        const vectorHits = await this.table
          .vectorSearch(embedding)
          .distanceType('cosine')
          .limit(limit * 2)  // 多取一些用于融合
          .toArray()
        vectorResults = this.formatResults(vectorHits, options)
      }

      // 2. BM25 搜索
      const bm25Index = getBM25Index()
      let bm25Results: BM25SearchResult[] = []
      if (bm25Index.isReady()) {
        bm25Results = await bm25Index.search(query, limit * 2, {
          hostId: options.hostId,
          tags: options.tags
        })
      }

      // 3. RRF 融合
      const fusedResults = this.rrfFusion(vectorResults, bm25Results, k)

      // 4. 返回前 limit 个结果
      return fusedResults.slice(0, limit)
    } catch (error) {
      log.error('Hybrid search failed:', error)
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`hybridSearch: ${(error as Error).message}`)
      }
      return []
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) 融合算法
   * 合并向量搜索和 BM25 搜索结果
   */
  private rrfFusion(
    vectorResults: SearchResult[],
    bm25Results: BM25SearchResult[],
    k: number = 60
  ): SearchResult[] {
    // 分数映射: id -> { score, result }
    const scoreMap = new Map<string, { score: number; result: SearchResult }>()

    // 向量搜索结果贡献分数
    vectorResults.forEach((result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      scoreMap.set(result.id, {
        score: rrfScore,
        result
      })
    })

    // BM25 结果贡献分数
    bm25Results.forEach((bm25Result, rank) => {
      const rrfScore = 1 / (k + rank + 1)
      
      if (scoreMap.has(bm25Result.id)) {
        // 已存在，累加分数
        const existing = scoreMap.get(bm25Result.id)!
        existing.score += rrfScore
      } else {
        // 新结果，转换为 SearchResult 格式
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

    // 按融合分数排序
    const results = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ score, result }) => ({
        ...result,
        score  // 使用 RRF 融合分数
      }))

    return results
  }

  /**
   * 格式化搜索结果
   */
  private formatResults(
    hits: any[], 
    options: Partial<SearchOptions>
  ): SearchResult[] {
    // 相似度阈值（cosine 距离下 score = 1 - _distance = cosine_similarity）
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

    // 按相似度阈值过滤（核心修复：过滤低相关性结果）
    results = results.filter(r => r.score >= similarityThreshold)

    // 按主机过滤（空 hostId 的记录对所有主机可见）
    if (options.hostId && options.hostId.trim()) {
      results = results.filter(r => !r.metadata.hostId || r.metadata.hostId === options.hostId)
    }

    // 按标签过滤
    if (options.tags && options.tags.length > 0) {
      results = results.filter(r => 
        options.tags!.some(tag => r.metadata.tags.includes(tag))
      )
    }

    const limit = options.limit || 10
    return results.slice(0, limit)
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<KnowledgeStats> {
    if (!this.table) {
      return {
        documentCount: 0,
        chunkCount: 0,
        totalSize: 0
      }
    }

    try {
      const chunkCount = await this.table.countRows()
      
      // 获取唯一文档数
      const allRows = await this.table.query().select(['docId']).toArray()
      const uniqueDocIds = new Set(allRows.map((r: any) => r.docId))

      return {
        documentCount: uniqueDocIds.size,
        chunkCount,
        totalSize: 0,
        lastUpdated: Date.now()
      }
    } catch (error) {
      // 物理损坏（manifest 指向不存在的 data 文件）会让 countRows/query 抛 IO；
      // 这里若仍然吞错返回 0，checkAndRebuildIndex 会判定 chunkCount=0 → 重建，
      // 而重建期间的 addRecords 会再次撞到同一损坏表，陷入死循环。
      // 标记后由下次启动 dropTable 重建（与 search 路径同款自愈）。
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getStats: ${(error as Error).message}`)
      }
      return {
        documentCount: 0,
        chunkCount: 0,
        totalSize: 0
      }
    }
  }

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    try {
      if (this.table) {
        await this.db.dropTable(this.tableName)
        this.table = null
      }
      
      // 彻底删除 LanceDB 数据目录中的表文件
      const tablePath = path.join(this.storagePath, `${this.tableName}.lance`)
      if (fs.existsSync(tablePath)) {
        fs.rmSync(tablePath, { recursive: true, force: true })
        log.info('已删除 LanceDB 数据目录:', tablePath)
      }
      
      this.deleteCount = 0
      this.emit('cleared')
    } catch (error) {
      log.error('Clear failed:', error)
      throw error
    }
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null
  }

  /**
   * 获取存储路径
   */
  getStoragePath(): string {
    return this.storagePath
  }

  /**
   * 获取属于指定 docIds 集合的所有记录（一次全表查询）
   */
  async getValidRecords(validDocIds: Set<string>): Promise<VectorRecord[]> {
    if (!this.table || validDocIds.size === 0) return []

    try {
      const allRows = await this.table.query().toArray()
      return (allRows as any[])
        .filter(r => validDocIds.has(r.docId))
        .map(r => ({
          id: r.id,
          docId: r.docId,
          content: r.content,
          // LanceDB 返回 Arrow FixedSizeList，需转为普通数组
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

  /**
   * 获取所有文档 ID（去重）
   */
  async getAllDocIds(): Promise<Set<string>> {
    if (!this.table) return new Set()

    try {
      const allRows = await this.table.query().select(['docId']).toArray()
      const docIds = new Set<string>()
      for (const row of allRows) {
        if ((row as any).docId) {
          docIds.add((row as any).docId)
        }
      }
      return docIds
    } catch (error) {
      log.error('Failed to get all docIds:', error)
      // 关键路径：cleanupOrphanData 依赖此方法判断是否有孤儿数据，
      // 如果这里因 LanceDB 物理损坏返回空 Set，会让 cleanupOrphanData 误判为
      // "没有孤儿"直接 return，损坏状态延续到下次启动也不会自愈。
      if (this.isLanceCorruptionError(error)) {
        this.markCorrupted(`getAllDocIds: ${(error as Error).message}`)
      }
      return new Set()
    }
  }
}

// 导出单例
let vectorStorage: VectorStorage | null = null

export function getVectorStorage(): VectorStorage {
  if (!vectorStorage) {
    vectorStorage = new VectorStorage()
  }
  return vectorStorage
}
