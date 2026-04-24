/**
 * Embedding 服务
 * 使用 @xenova/transformers 进行本地文本向量化
 */
import { EventEmitter } from 'events'
import type { ModelTier, ModelInfo } from './types'
import { getModelManager, ModelManager } from './model-manager'
import { createLogger } from '../../utils/logger'

const log = createLogger('Embedding')

// 动态导入 transformers（延迟加载）
let pipeline: any = null
let env: any = null

async function loadTransformers() {
  if (!pipeline) {
    const transformers = await import('@xenova/transformers')
    pipeline = transformers.pipeline
    env = transformers.env
    
    // 配置 transformers
    env.allowLocalModels = true
    env.allowRemoteModels = false  // 禁用远程下载，使用我们自己的下载管理
  }
  return { pipeline, env }
}

export class EmbeddingService extends EventEmitter {
  private modelManager: ModelManager
  private currentModelId: ModelTier | null = null
  private extractor: any = null
  private isLoading: boolean = false
  private loadPromise: Promise<void> | null = null

  constructor() {
    super()
    this.modelManager = getModelManager()
  }

  /**
   * 初始化 Embedding 服务
   * @param modelId 指定模型，不指定则使用最佳可用模型
   */
  async initialize(modelId?: ModelTier): Promise<void> {
    // 如果正在加载，等待加载完成
    if (this.loadPromise) {
      await this.loadPromise
      return
    }

    // 确定要加载的模型
    const targetModel = modelId 
      ? this.modelManager.getModel(modelId)
      : this.modelManager.getBestAvailableModel()

    // 检查模型是否可用
    if (!this.modelManager.isModelAvailable(targetModel.id)) {
      // 如果指定的模型不可用，降级到轻量模型
      if (modelId && modelId !== 'lite') {
        log.warn(`Model ${modelId} not available, falling back to lite`)
        return this.initialize('lite')
      }
      throw new Error(`模型 ${targetModel.id} 不可用，请先下载`)
    }

    // 如果当前模型就是目标模型，跳过
    if (this.currentModelId === targetModel.id && this.extractor) {
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

  /**
   * 实际执行初始化
   */
  private async doInitialize(model: ModelInfo): Promise<void> {
    try {
      const { pipeline, env } = await loadTransformers()
      
      // 获取模型路径
      const modelPath = this.modelManager.getModelPath(model.id)
      
      // 获取模型父目录和文件夹名
      const path = await import('path')
      const modelDir = path.dirname(modelPath)  // 父目录：resources/models/embedding
      const modelName = path.basename(modelPath) // 文件夹名：bge-small-zh-v1.5
      
      // 禁止远程下载，设置本地模型路径为父目录
      env.allowRemoteModels = false
      env.localModelPath = modelDir

      // 创建 feature-extraction pipeline
      // 使用文件夹名作为模型标识符（会在 localModelPath 下查找）
      this.extractor = await pipeline('feature-extraction', modelName, {
        local_files_only: true
      })

      this.currentModelId = model.id
      this.emit('loaded', model.id)
    } catch (error) {
      log.error('Failed to load model:', error)
      this.emit('error', error)
      throw error
    }
  }

  /**
   * 生成文本的向量嵌入
   * @param texts 文本数组
   * @returns 向量数组
   *
   * 使用 batch inference：一次 forward pass 处理整个 batch，
   * 相比逐条串行在 CPU 上通常有 3-8 倍加速（避免重复的
   * session.run 调度开销 + attention 层计算可部分共享）。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor) {
      await this.initialize()
    }

    if (!this.extractor) {
      throw new Error('Embedding 模型未加载')
    }

    if (texts.length === 0) return []

    try {
      // 截断过长的文本（大多数模型限制 512 tokens，2000 字符留些余量给中文）
      const truncated = texts.map(t => t.slice(0, 2000))

      // 一次性 forward 整个 batch
      const output = await this.extractor(truncated, {
        pooling: 'mean',
        normalize: true
      })

      // feature-extraction + pooling='mean' 的输出 shape = [B, D]
      // output.data 是扁平的 Float32Array（行主序），长度 = B * D
      const data = output.data as Float32Array
      const dims = output.dims as number[] | undefined
      const dim = dims && dims.length >= 2
        ? dims[dims.length - 1]
        : Math.floor(data.length / truncated.length)

      if (!dim || data.length !== truncated.length * dim) {
        // 理论不会发生，兜底防御：形状异常时降级为单条处理，保证正确性优先
        log.warn(`batch embed 输出形状异常，dims=${JSON.stringify(dims)}, data.length=${data.length}，降级为单条推理`)
        return this.embedFallbackSequential(truncated)
      }

      const results: number[][] = new Array(truncated.length)
      for (let i = 0; i < truncated.length; i++) {
        results[i] = Array.from(data.subarray(i * dim, (i + 1) * dim))
      }
      return results
    } catch (error) {
      log.error('Failed to generate embeddings:', error)
      throw error
    }
  }

  /**
   * 降级：逐条推理（仅在 batch 输出形状异常时使用）
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

  /**
   * 生成单个文本的向量嵌入
   */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text])
    return results[0]
  }

  /**
   * 切换模型
   */
  async switchModel(modelId: ModelTier): Promise<void> {
    if (modelId === this.currentModelId) {
      return
    }

    // 释放当前模型
    this.dispose()

    // 加载新模型
    await this.initialize(modelId)
  }

  /**
   * 获取当前模型信息
   */
  getCurrentModel(): ModelInfo | null {
    if (!this.currentModelId) {
      return null
    }
    return this.modelManager.getModel(this.currentModelId)
  }

  /**
   * 获取当前向量维度
   */
  getDimensions(): number {
    const model = this.getCurrentModel()
    return model?.dimensions || 384
  }

  /**
   * 检查服务是否就绪
   */
  isReady(): boolean {
    return this.extractor !== null && !this.isLoading
  }

  /**
   * 检查是否正在加载
   */
  isModelLoading(): boolean {
    return this.isLoading
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.extractor = null
    this.currentModelId = null
    this.emit('disposed')
  }

  /**
   * 计算两个向量的余弦相似度
   */
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

    if (normA === 0 || normB === 0) {
      return 0
    }

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

