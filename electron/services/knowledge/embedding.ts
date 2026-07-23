/**
 * Embedding 服务
 *
 * 优先把推理放到 utilityProcess（独立子进程），与主进程的 v8 堆 / partition
 * allocator 隔离。使用 @huggingface/transformers v4 + onnxruntime-node（CoreML/CUDA/DML）。
 *
 * 当 utilityProcess 不可用（例如 CLI 模式跑在纯 Node.js 下，electron shim
 * 把 utilityProcess.fork 桩成返回 null），自动退回到主进程内推理，对调用方
 * 透明。CLI 场景吞吐次要，可靠性优先。
 */
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import type { ModelTier, ModelInfo, EmbeddingDevice } from './types'
import { getModelManager, ModelManager } from './model-manager'
import {
  normalizeEmbeddingDevice,
  buildEmbeddingPipelineOptions,
  getEmbeddingInitDeviceCandidates,
  resolvePipelineDevice,
} from './embedding-device'
import { createLogger } from '../../utils/logger'

const log = createLogger('Embedding')

// ────────────────────────── transformers 延迟加载（仅 in-process 路径使用） ──────────────────────────

let inProcPipeline: any = null
let inProcEnv: any = null

async function loadTransformersInProc() {
  if (!inProcPipeline) {
    const transformers = await import('@huggingface/transformers')
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
 * @huggingface/transformers 与其原生依赖 onnxruntime-node。
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
  /** 连续成功的 worker embed 批次数，达上限后主动重启 worker 释放 BFC arena */
  private successfulWorkerBatches = 0
  private nextMessageId: number = 0
  private pending: Map<number, PendingCall> = new Map()
  /**
   * disposeAsync 触发后，禁止新的 callWorker 进入。
   * 否则在 race timeout 之后还可能有调用者把请求塞进 pending，
   * 紧接着 killWorker 会把这些请求 reject 成"Embedding worker terminated"。
   * 加锁是为了让调用方收到更明确的错误，并避免误用一个正在销毁的 service。
   */
  private isDisposing: boolean = false

  // ── In-process 模式（CLI / 测试 / fallback） ──────────────────
  private extractor: any = null
  private embeddingDevice: EmbeddingDevice = 'auto'
  /** 本次成功加载实际使用的 pipeline 设备（可能与配置不同，例如 DML 失败后回退 CPU） */
  private runtimePipelineDevice: EmbeddingDevice | null = null

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
   * 注意：worker 模式下 BFC arena 与主进程 v8 堆不再共享地址空间，地址冲突
   * 风险消除，但 BFC arena 自身仍会指数扩张，请通过实例方法 getMaxBatchSize()
   * 取动态值（worker=16 / in-process=16）。worker 虽在独立进程，BFC arena 仍会
   * 随连续推理指数扩张，故 batch 与 in-process 对齐，并配合定期重启 worker。
   */
  static readonly MAX_BATCH_SIZE = 16

  /**
   * worker 模式下的 batch 上限（与 in-process 对齐）。
   *
   * 此前 batch=32 在长时索引重建中仍会触达 BFC arena 2GB 边界 → SIGTRAP(code=5)。
   * 16 更稳；吞吐靠 utilityProcess 隔离 + 定期重启 worker 弥补。
   */
  static readonly MAX_BATCH_SIZE_WORKER = 16

  /** GPU/CoreML/CUDA 路径下 worker batch 上限 */
  static readonly MAX_BATCH_SIZE_WORKER_ACCEL = 32

  /** 每 N 次成功 embed 后主动重启 worker，重置 BFC arena，防 SIGTRAP */
  static readonly WORKER_RESTART_INTERVAL = 15

  /** 加速设备下延长重启间隔（内存压力更小） */
  static readonly WORKER_RESTART_INTERVAL_ACCEL = 30

  /** worker embed 单次失败后的最大重试次数（每次重试前重启 worker） */
  static readonly MAX_WORKER_EMBED_ATTEMPTS = 3

  /**
   * 当前实例的批量上限（依据运行模式动态返回）
   *
   * - worker 模式：16（独立进程，定期重启防 BFC arena 触顶）
   * - in-process 模式：16（主进程内，受 BFC arena 与 v8 堆共享地址空间限制）
   */
  getMaxBatchSize(): number {
    const device = this.runtimePipelineDevice ?? resolvePipelineDevice(this.embeddingDevice)
    if (this.useWorker) {
      return device !== 'cpu'
        ? EmbeddingService.MAX_BATCH_SIZE_WORKER_ACCEL
        : EmbeddingService.MAX_BATCH_SIZE_WORKER
    }
    return EmbeddingService.MAX_BATCH_SIZE
  }

  private getWorkerRestartInterval(): number {
    const device = this.runtimePipelineDevice ?? resolvePipelineDevice(this.embeddingDevice)
    return device !== 'cpu'
      ? EmbeddingService.WORKER_RESTART_INTERVAL_ACCEL
      : EmbeddingService.WORKER_RESTART_INTERVAL
  }

  /** 设置嵌入推理设备（变更后下次 initialize 生效；若已加载则 dispose） */
  setDevice(device?: string | null): void {
    const next = normalizeEmbeddingDevice(device)
    if (next === this.embeddingDevice) return
    this.embeddingDevice = next
    if (this.extractor || this.worker) {
      this.dispose()
    }
  }

  getDevice(): EmbeddingDevice {
    return this.embeddingDevice
  }

  private buildWorkerInitPayload(
    modelDir: string,
    modelName: string,
    pipelineDevice: EmbeddingDevice,
  ) {
    const opts = buildEmbeddingPipelineOptions(pipelineDevice)
    return {
      modelDir,
      modelName,
      device: opts.device,
      dtype: opts.dtype,
    }
  }

  private async loadWithPipelineDevice(
    model: ModelInfo,
    pipelineDevice: EmbeddingDevice,
  ): Promise<{ useWorker: boolean; device: EmbeddingDevice }> {
    const modelPath = this.modelManager.getModelPath(model.id)
    const modelDir = path.dirname(modelPath)
    const modelName = path.basename(modelPath)
    const pipelineOpts = buildEmbeddingPipelineOptions(pipelineDevice)

    // 桌面端 utilityProcess 可用：必须走 worker；失败直接抛出，禁止静默回退主进程
    if (detectUtilityProcessAvailable()) {
      try {
        await this.startWorker()
        const initPayload = this.buildWorkerInitPayload(modelDir, modelName, pipelineDevice)
        const initResult = await this.callWorker('initialize', initPayload)
        return {
          useWorker: true,
          device: (initResult?.device ?? pipelineOpts.device) as EmbeddingDevice,
        }
      } catch (workerError) {
        this.killWorker()
        const detail = workerError instanceof Error ? workerError.message : String(workerError)
        const err = new Error(
          `Embedding worker 初始化失败（禁止回退主进程）：${detail}。` +
            `若为打包版，请检查 asarUnpack 是否包含 onnxruntime-common / @huggingface/jinja / @huggingface/tokenizers。`,
        )
        log.error(err.message, workerError)
        throw err
      }
    }

    // CLI / shim：utilityProcess 不可用，进程内是唯一模式
    const { pipeline, env } = await loadTransformersInProc()
    env.allowRemoteModels = false
    env.localModelPath = modelDir
    this.extractor = await pipeline('feature-extraction', modelName, pipelineOpts)
    return { useWorker: false, device: pipelineOpts.device }
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
    const candidates = getEmbeddingInitDeviceCandidates(this.embeddingDevice)
    const primary = candidates[0]
    let lastError: unknown

    for (const pipelineDevice of candidates) {
      try {
        this.killWorker()
        this.extractor = null

        const result = await this.loadWithPipelineDevice(model, pipelineDevice)
        this.useWorker = result.useWorker
        this.runtimePipelineDevice = result.device
        this.currentModelId = model.id

        if (result.device === 'cpu' && primary !== 'cpu') {
          log.warn('加速设备 %s 不可用，已回退到 CPU', primary)
        }

        const modeLabel = result.useWorker ? 'worker 进程' : '主进程'
        log.info(
          'Embedding 模型已加载到 %s：%s（device=%s，batch=%d）',
          modeLabel,
          model.id,
          result.device,
          this.getMaxBatchSize(),
        )
        this.emit('loaded', model.id)
        return
      } catch (error) {
        lastError = error
        this.killWorker()
        this.extractor = null
        if (pipelineDevice !== 'cpu') {
          log.warn('Embedding 设备 %s 加载失败，尝试回退：', pipelineDevice, error)
        }
      }
    }

    log.error('Failed to load model:', lastError)
    this.emit('error', lastError)
    throw lastError
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

    // NODE_PATH 让 worker 能 require('@huggingface/transformers') 与 onnxruntime-node
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
        log.warn('Embedding worker 异常退出（code=%s），将在下次 embed 时重启 worker', code)
      }
      // 保留 useWorker=true：下次 embedBatch 会 restartWorkerSession，
      // 切勿改成 false 后误走空的 in-process extractor（extractor 从未加载）。
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
    // disposeAsync 已经向 worker 发出 dispose 并准备 kill；
    // 拒绝新调用，避免请求进入 pending 后被 kill 强制 reject 出难定位的错误。
    // 注意：我们故意不拦截 'dispose' 自己的调用，让 disposeAsync 的 RPC 能继续。
    if (this.isDisposing && type !== 'dispose') {
      return Promise.reject(new Error('Embedding service is being disposed'))
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
    // Worker 模式：worker 进程可能已退出但 useWorker 仍为 true；必须重启，禁止误调空 extractor
    if (this.useWorker) {
      if (!this.worker) {
        await this.restartWorkerSession()
      }
      return this.embedBatchWorker(texts)
    }
    if (typeof this.extractor !== 'function') {
      throw new Error('Embedding 模型未加载（in-process extractor 无效）')
    }
    return this.embedBatchInProc(texts)
  }

  private async embedBatchWorker(texts: string[]): Promise<number[][]> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < EmbeddingService.MAX_WORKER_EMBED_ATTEMPTS; attempt++) {
      try {
        const result = await this.embedBatchWorkerOnce(texts)
        this.successfulWorkerBatches++
        if (this.successfulWorkerBatches >= this.getWorkerRestartInterval()) {
          this.successfulWorkerBatches = 0
          log.info('Embedding worker 定期重启以释放 BFC arena')
          await this.restartWorkerSession()
        }
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        log.warn(
          `Worker embed 失败（第 ${attempt + 1}/${EmbeddingService.MAX_WORKER_EMBED_ATTEMPTS} 次），重启 worker 后重试：`,
          lastError.message
        )
        await this.restartWorkerSession().catch((restartErr) => {
          log.error('重启 Embedding worker 失败：', restartErr)
        })
      }
    }
    throw lastError ?? new Error('Worker embed failed after retries')
  }

  private async embedBatchWorkerOnce(texts: string[]): Promise<number[][]> {
    if (!this.worker || !this.useWorker) {
      await this.restartWorkerSession()
    }

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
  }

  /**
   * 杀掉并重新拉起 utilityProcess worker（保持当前模型，不走主进程推理）。
   */
  private async restartWorkerSession(): Promise<void> {
    this.killWorker()
    this.useWorker = false

    const modelId = this.currentModelId
    if (!modelId) {
      throw new Error('Embedding 模型未加载，无法重启 worker')
    }

    const model = this.modelManager.getModel(modelId)
    const modelPath = this.modelManager.getModelPath(model.id)
    const modelDir = path.dirname(modelPath)
    const modelName = path.basename(modelPath)
    const pipelineDevice = this.runtimePipelineDevice ?? resolvePipelineDevice(this.embeddingDevice)

    await this.startWorker()
    await this.callWorker(
      'initialize',
      this.buildWorkerInitPayload(modelDir, modelName, pipelineDevice),
    )
    this.useWorker = true
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

  /**
   * 释放资源（同步入口，主要给 switchModel / 错误恢复用）
   *
   * 注意：worker 的 dispose 消息发出后立刻被 killWorker 抢断，worker 内部
   * ORT session 没有机会干净释放。如需"主进程退出前优雅关闭 worker"，
   * 请使用 disposeAsync。
   */
  dispose(): void {
    if (this.worker) {
      this.callWorker('dispose').catch(() => {/* ignore */})
      this.killWorker()
    }
    // CLI / 进程内路径：同步入口无法 await；fire-and-forget 仍优于直接丢弃 session
    const extractor = this.extractor as { dispose?: () => Promise<void> } | null
    if (extractor?.dispose) {
      extractor.dispose().catch(() => {/* ignore */})
    }
    this.extractor = null
    this.useWorker = false
    this.currentModelId = null
    this.runtimePipelineDevice = null
    this.emit('disposed')
  }

  /**
   * 优雅释放：给 worker 一段时间处理 dispose 消息后再 kill，
   * 用于主进程 quit 路径，减少"worker 在 ORT session 释放中途被 SIGKILL"。
   * CLI 进程内推理路径必须 await extractor.dispose()，否则 ORT 在 process.exit 时 SIGABRT。
   */
  async disposeAsync(timeoutMs: number = 500): Promise<void> {
    this.isDisposing = true
    if (this.worker) {
      try {
        await Promise.race([
          this.callWorker('dispose'),
          new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
        ])
      } catch { /* ignore */ }
      this.killWorker()
    }
    const extractor = this.extractor as { dispose?: () => Promise<void> } | null
    if (extractor?.dispose) {
      try {
        await Promise.race([
          extractor.dispose(),
          new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
        ])
      } catch { /* ignore */ }
    }
    this.extractor = null
    this.useWorker = false
    this.currentModelId = null
    this.runtimePipelineDevice = null
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
