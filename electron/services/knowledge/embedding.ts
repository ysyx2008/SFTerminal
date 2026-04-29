/**
 * Embedding 服务
 *
 * 优先把推理放到 utilityProcess（独立子进程），与主进程的 v8 堆 / partition
 * allocator 隔离。这样能避开 onnxruntime-node 1.14 的 BFC arena 扩张和主进程
 * 地址空间相互踩踏导致 SIGTRAP（详见下方 MAX_BATCH_SIZE 注释）。
 *
 * 当 utilityProcess 不可用（例如 CLI 模式跑在纯 Node.js 下，electron shim
 * 把 utilityProcess.fork 桩成返回 null），自动退回到主进程内推理，对调用方
 * 透明。CLI 场景吞吐次要，可靠性优先。
 */
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import type { ModelTier, ModelInfo } from './types'
import { getModelManager, ModelManager } from './model-manager'
import { createLogger } from '../../utils/logger'

const log = createLogger('Embedding')

// ────────────────────────── transformers 延迟加载（仅 in-process 路径使用） ──────────────────────────

let inProcPipeline: any = null
let inProcEnv: any = null

async function loadTransformersInProc() {
  if (!inProcPipeline) {
    const transformers = await import('@xenova/transformers')
    inProcPipeline = transformers.pipeline
    inProcEnv = transformers.env
    inProcEnv.allowLocalModels = true
    inProcEnv.allowRemoteModels = false
  }
  return { pipeline: inProcPipeline, env: inProcEnv }
}

// ────────────────────────── Worker 路径解析 ──────────────────────────

/**
 * 获取 utilityProcess worker 脚本的绝对路径
 *
 * 与 speech-worker 路径解析一致：
 *  - 打包后：app.asar.unpacked/dist-electron/services/knowledge/embedding-worker.js
 *  - 开发期：electron/services/knowledge/embedding-worker.js
 */
function getWorkerScriptPath(): string {
  // app.isPackaged 只在加载到 electron 模块后可用，CLI 环境下访问会拿到 stub 的 false
  // 这里走文件存在性兜底：先查打包后路径，再查开发路径
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    if (app && app.isPackaged) {
      return path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'dist-electron',
        'services',
        'knowledge',
        'embedding-worker.js'
      )
    }
  } catch {
    // ignore: 非 Electron 环境
  }
  return path.join(process.cwd(), 'electron', 'services', 'knowledge', 'embedding-worker.js')
}

/**
 * 探测 utilityProcess 是否真实可用
 *
 * Electron 主进程下 utilityProcess.fork 是真函数；
 * CLI shim 把它桩成 `() => null`，调用 fork 也能返回但拿到 null。
 * 我们通过 process.type === 'browser' + utilityProcess 是否为函数双重判断。
 */
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

/**
 * 获取 unpacked 的 node_modules 路径，让 worker 进程的 require 能找到
 * @xenova/transformers 与其原生依赖 onnxruntime-node。
 */
function getUnpackedNodeModules(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    }
  } catch {
    // ignore
  }
  return path.join(process.cwd(), 'node_modules')
}

// ────────────────────────── EmbeddingService ──────────────────────────

interface PendingCall {
  resolve: (value: any) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

const WORKER_CALL_TIMEOUT_MS = 5 * 60 * 1000 // 单次调用 5 分钟超时（embed 大批量在弱机上可能数十秒）

export class EmbeddingService extends EventEmitter {
  private modelManager: ModelManager
  private currentModelId: ModelTier | null = null
  private isLoading: boolean = false
  private loadPromise: Promise<void> | null = null

  // ── Worker 模式（utilityProcess） ─────────────────────────────
  private worker: any = null // Electron UtilityProcess
  private useWorker: boolean = false
  private nextMessageId: number = 0
  private pending: Map<number, PendingCall> = new Map()

  // ── In-process 模式（CLI / 测试 / fallback） ──────────────────
  private extractor: any = null

  constructor() {
    super()
    this.modelManager = getModelManager()
  }

  /**
   * 单次 forward 的最大 batch 大小（in-process 模式安全值）。
   *
   * onnxruntime-node@1.14（被 @xenova/transformers@2.x 钉死的旧版）跑在
   * Electron 主进程主线程，单次 forward 的中间 tensor 与 BFCArena 块
   * 都从 process heap 通过 posix_memalign 申请，与 v8 的 cppgc /
   * partition alloc 共享地址空间。
   *
   * BGE-small 在 batch=64、max_seq_len=512 时，单个 attention scores
   * 张量 [B, H, T, T] = [64, 12, 512, 512] float32 ≈ 768MB，BFC arena
   * 每次扩张是上一次的 2 倍，连续推理几次后会请求 ≥2GB 的"下一片"，
   * 命中 macOS libsystem_malloc 对 posix_memalign 的 size sanity check，
   * 触发 SIGTRAP（EXC_BREAKPOINT brk 0）直接 crash 整个进程，try/catch
   * 在 native 层接不住。
   *
   * 16 是稳妥的折中：单批 attention 张量从 768MB 降到约 48MB，BFC arena
   * 触达 2GB 边界的概率极低；相对逐条推理仍有 5-10× 加速。
   *
   * 注意：worker 模式下 BFC arena 与主进程 v8 堆不再共享地址空间，
   * 此限制不再适用，请通过实例方法 getMaxBatchSize() 取动态值。
   */
  static readonly MAX_BATCH_SIZE = 16

  /** worker 模式下放宽的 batch 上限（独立进程，BFC arena 不再撞主进程 v8 堆） */
  static readonly MAX_BATCH_SIZE_WORKER = 64

  /**
   * 当前实例的批量上限（依据运行模式动态返回）
   *
   * - worker 模式：64（独立进程，地址空间隔离）
   * - in-process 模式：16（主进程内，受 BFC arena 与 v8 堆共享地址空间限制）
   */
  getMaxBatchSize(): number {
    return this.useWorker
      ? EmbeddingService.MAX_BATCH_SIZE_WORKER
      : EmbeddingService.MAX_BATCH_SIZE
  }

  /**
   * 初始化 Embedding 服务
   * @param modelId 指定模型，不指定则使用最佳可用模型
   */
  async initialize(modelId?: ModelTier): Promise<void> {
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    const targetModel = modelId
      ? this.modelManager.getModel(modelId)
      : this.modelManager.getBestAvailableModel()

    if (!this.modelManager.isModelAvailable(targetModel.id)) {
      if (modelId && modelId !== 'lite') {
        log.warn(`Model ${modelId} not available, falling back to lite`)
        return this.initialize('lite')
      }
      throw new Error(`模型 ${targetModel.id} 不可用，请先下载`)
    }

    if (this.currentModelId === targetModel.id && (this.extractor || this.worker)) {
      return
    }

    this.isLoading = true
    this.emit('loading', targetModel.id)

    this.loadPromise = this.doInitialize(targetModel)

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
      this.isLoading = false
    }
  }

  private async doInitialize(model: ModelInfo): Promise<void> {
    try {
      const modelPath = this.modelManager.getModelPath(model.id)
      const modelDir = path.dirname(modelPath)
      const modelName = path.basename(modelPath)

      // ── 优先尝试 worker 模式 ────────────────────────────────
      if (detectUtilityProcessAvailable()) {
        try {
          await this.startWorker()
          await this.callWorker('initialize', { modelDir, modelName })
          this.useWorker = true
          this.currentModelId = model.id
          log.info(
            'Embedding 模型已加载到 worker 进程：%s（batch=%d）',
            model.id,
            this.getMaxBatchSize()
          )
          this.emit('loaded', model.id)
          return
        } catch (workerError) {
          log.warn('Worker 模式初始化失败，回退到主进程内推理：', workerError)
          this.killWorker()
        }
      }

      // ── 退回主进程内推理（CLI / 测试 / worker 启动失败） ──────
      const { pipeline, env } = await loadTransformersInProc()
      env.allowRemoteModels = false
      env.localModelPath = modelDir

      this.extractor = await pipeline('feature-extraction', modelName, {
        local_files_only: true
      })

      this.useWorker = false
      this.currentModelId = model.id
      log.info(
        'Embedding 模型已加载到主进程：%s（batch=%d，建议在 Electron 环境下走 worker）',
        model.id,
        this.getMaxBatchSize()
      )
      this.emit('loaded', model.id)
    } catch (error) {
      log.error('Failed to load model:', error)
      this.emit('error', error)
      throw error
    }
  }

  // ────────────────────────── Worker 启停 / RPC ──────────────────────────

  private async startWorker(): Promise<void> {
    if (this.worker) return

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { utilityProcess } = require('electron')

    const workerPath = getWorkerScriptPath()
    if (!fs.existsSync(workerPath)) {
      throw new Error(`Embedding worker 脚本不存在：${workerPath}`)
    }

    const unpackedNM = getUnpackedNodeModules()
    const workerEnv: NodeJS.ProcessEnv = { ...process.env }

    // NODE_PATH 让 worker 能 require('@xenova/transformers') 与 onnxruntime-node
    workerEnv.NODE_PATH = workerEnv.NODE_PATH
      ? `${unpackedNM}${path.delimiter}${workerEnv.NODE_PATH}`
      : unpackedNM

    const proc = utilityProcess.fork(workerPath, [], {
      env: workerEnv,
      stdio: 'pipe'
    })

    if (!proc) {
      // CLI shim 会返回 null
      throw new Error('utilityProcess.fork 返回 null（可能运行在 CLI/测试环境）')
    }

    this.worker = proc

    proc.on('message', (msg: any) => this.onWorkerMessage(msg))

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.info('[worker]', text)
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) log.warn('[worker]', text)
    })

    proc.on('exit', (code: number | null) => {
      log.info('Embedding worker 退出，code=%s', code)
      const isUnexpected = code !== null && code !== 0 && code !== 15 // 15 = SIGTERM 主动 kill
      if (isUnexpected) {
        log.error('Embedding worker 异常退出，所有进行中的 embed 调用将失败')
      }
      this.worker = null
      // 拒绝所有 pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`Embedding worker exited with code ${code}`))
      }
      this.pending.clear()
    })
  }

  private killWorker(): void {
    if (!this.worker) return
    try {
      this.worker.kill()
    } catch (e) {
      log.warn('kill worker 失败：', e)
    }
    this.worker = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('Embedding worker terminated'))
    }
    this.pending.clear()
  }

  private onWorkerMessage(msg: any): void {
    if (!msg || typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.success) {
      p.resolve(msg.result)
    } else {
      const err = new Error(msg.error || 'Embedding worker error')
      if (msg.stack) (err as any).workerStack = msg.stack
      p.reject(err)
    }
  }

  private callWorker<T = any>(type: string, data?: any): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Embedding worker 未启动'))
    }
    const id = ++this.nextMessageId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`Embedding worker 调用超时（type=${type}）`))
        }
      }, WORKER_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.worker.postMessage({ id, type, data })
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ────────────────────────── embed 接口 ──────────────────────────

  /**
   * 生成文本的向量嵌入
   * @param texts 文本数组
   * @returns 向量数组
   *
   * 内部按 getMaxBatchSize() 切片：worker 模式 64 / in-process 模式 16，
   * 防止单批攻击主进程地址空间。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor && !this.worker) {
      await this.initialize()
    }

    if (!this.extractor && !this.worker) {
      throw new Error('Embedding 模型未加载')
    }

    if (texts.length === 0) return []

    // 截断过长的文本（大多数模型限制 512 tokens，2000 字符留些余量给中文）
    const truncated = texts.map(t => t.slice(0, 2000))

    const batchSize = this.getMaxBatchSize()

    if (truncated.length <= batchSize) {
      return this.embedBatch(truncated)
    }

    // 分片串行推理
    const results: number[][] = []
    for (let start = 0; start < truncated.length; start += batchSize) {
      const slice = truncated.slice(start, start + batchSize)
      const sliceResults = await this.embedBatch(slice)
      results.push(...sliceResults)
    }
    return results
  }

  /**
   * 单次 batch forward（输入长度必须 ≤ getMaxBatchSize()）。
   */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.useWorker && this.worker) {
      return this.embedBatchWorker(texts)
    }
    return this.embedBatchInProc(texts)
  }

  private async embedBatchWorker(texts: string[]): Promise<number[][]> {
    try {
      const ret = await this.callWorker<{
        flat?: Float32Array
        vectors?: number[][]
        dim: number
        count?: number
        fallback?: boolean
      }>('embed', { texts })

      // worker 内已发生形状异常 fallback，直接返回它给的 number[][]
      if (ret.vectors) return ret.vectors

      const flat = ret.flat
      const dim = ret.dim
      if (!flat || !dim) {
        throw new Error('Embedding worker 返回数据异常（缺少 flat/dim）')
      }

      // structured clone 后 flat 仍是 Float32Array，按行切回 number[]
      const results: number[][] = new Array(texts.length)
      for (let i = 0; i < texts.length; i++) {
        results[i] = Array.from(flat.subarray(i * dim, (i + 1) * dim))
      }
      return results
    } catch (error) {
      log.error('Worker embed 失败：', error)
      throw error
    }
  }

  private async embedBatchInProc(texts: string[]): Promise<number[][]> {
    try {
      const output = await this.extractor(texts, {
        pooling: 'mean',
        normalize: true
      })

      const data = output.data as Float32Array
      const dims = output.dims as number[] | undefined
      const dim = dims && dims.length >= 2
        ? dims[dims.length - 1]
        : Math.floor(data.length / texts.length)

      if (!dim || data.length !== texts.length * dim) {
        log.warn(
          `batch embed 输出形状异常，dims=${JSON.stringify(dims)}, data.length=${data.length}，降级为单条推理`
        )
        return this.embedFallbackSequential(texts)
      }

      const results: number[][] = new Array(texts.length)
      for (let i = 0; i < texts.length; i++) {
        results[i] = Array.from(data.subarray(i * dim, (i + 1) * dim))
      }
      return results
    } catch (error) {
      log.error('Failed to generate embeddings:', error)
      throw error
    }
  }

  /**
   * In-process 降级：逐条推理（仅在 batch 输出形状异常时使用）
   */
  private async embedFallbackSequential(texts: string[]): Promise<number[][]> {
    const results: number[][] = []
    for (const text of texts) {
      const output = await this.extractor(text, {
        pooling: 'mean',
        normalize: true
      })
      results.push(Array.from(output.data as Float32Array))
    }
    return results
  }

  /** 生成单个文本的向量嵌入 */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text])
    return results[0]
  }

  /** 切换模型 */
  async switchModel(modelId: ModelTier): Promise<void> {
    if (modelId === this.currentModelId) return
    this.dispose()
    await this.initialize(modelId)
  }

  /** 获取当前模型信息 */
  getCurrentModel(): ModelInfo | null {
    if (!this.currentModelId) return null
    return this.modelManager.getModel(this.currentModelId)
  }

  /** 获取当前向量维度 */
  getDimensions(): number {
    const model = this.getCurrentModel()
    return model?.dimensions || 384
  }

  /** 检查服务是否就绪 */
  isReady(): boolean {
    return (this.extractor !== null || this.worker !== null) && !this.isLoading
  }

  /** 检查是否正在加载 */
  isModelLoading(): boolean {
    return this.isLoading
  }

  /** 释放资源 */
  dispose(): void {
    if (this.worker) {
      // 先尝试通过 dispose 让 worker 释放 extractor，再 kill
      this.callWorker('dispose').catch(() => {/* ignore */})
      this.killWorker()
    }
    this.extractor = null
    this.useWorker = false
    this.currentModelId = null
    this.emit('disposed')
  }

  /** 计算两个向量的余弦相似度 */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('向量维度不匹配')
    }

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    normA = Math.sqrt(normA)
    normB = Math.sqrt(normB)

    if (normA === 0 || normB === 0) return 0

    return dotProduct / (normA * normB)
  }
}

// 导出单例
let embeddingService: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService()
  }
  return embeddingService
}
