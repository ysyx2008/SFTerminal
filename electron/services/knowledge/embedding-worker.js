/* eslint-env node */
/**
 * Embedding Worker（utilityProcess）
 *
 * 把 @xenova/transformers + onnxruntime-node 的推理放到独立 utilityProcess，
 * 与主进程的 v8 堆 / partition allocator 隔离，避免 BFC arena 扩张时撞上
 * 主进程的地址空间限制（参见 embedding.ts 中关于 SIGTRAP 的注释）。
 *
 * 进程隔离后，原本被压到 16 的 batch size 可以放宽，吞吐能再涨 1.5~2×。
 *
 * 通信协议：
 *   ⇢ { id, type: 'initialize', data: { modelDir, modelName } }
 *   ⇢ { id, type: 'embed',      data: { texts: string[] } }
 *   ⇢ { id, type: 'dispose' }
 *   ⇠ { id, success, result }   |   { id, success: false, error }
 *
 * 串行化：所有消息按到达顺序排进同一条 promise 链，worker 内部不并发推理。
 *   onnxruntime-node 1.14 的 InferenceSession 本就不支持并发 run，与既有
 *   in-process 实现的语义保持一致。
 */
'use strict'

let pipeline = null
let env = null
let extractor = null
let currentModelKey = null

/**
 * 延迟加载 transformers，避免在 worker 启动时就把整个库拉起来。
 */
async function loadTransformers() {
  if (pipeline) return { pipeline, env }
  const transformers = await import('@xenova/transformers')
  pipeline = transformers.pipeline
  env = transformers.env
  env.allowLocalModels = true
  env.allowRemoteModels = false
  return { pipeline, env }
}

async function handleInitialize(data) {
  const { modelDir, modelName } = data || {}
  if (!modelDir || !modelName) {
    throw new Error('initialize 缺少参数：需要 modelDir 与 modelName')
  }

  const key = `${modelDir}::${modelName}`
  if (extractor && currentModelKey === key) {
    return { already: true }
  }

  // 切换模型时先释放旧 extractor 的引用，让 GC 回收 ORT session
  if (extractor) {
    extractor = null
    currentModelKey = null
  }

  const t = await loadTransformers()
  t.env.allowRemoteModels = false
  t.env.localModelPath = modelDir

  extractor = await t.pipeline('feature-extraction', modelName, {
    local_files_only: true
  })
  currentModelKey = key

  return { loaded: true, modelName }
}

async function handleEmbed(data) {
  if (!extractor) {
    throw new Error('Embedding 模型未加载，请先调用 initialize')
  }

  const { texts } = data || {}
  if (!Array.isArray(texts)) {
    throw new Error('embed 参数 texts 必须为字符串数组')
  }
  if (texts.length === 0) {
    return { vectors: [], dim: 0 }
  }

  const output = await extractor(texts, {
    pooling: 'mean',
    normalize: true
  })

  // feature-extraction + pooling='mean' 的输出 shape = [B, D]
  // output.data 是扁平的 Float32Array（行主序），长度 = B * D
  const data2 = output.data
  const dims = output.dims
  const dim = (dims && dims.length >= 2)
    ? dims[dims.length - 1]
    : Math.floor(data2.length / texts.length)

  if (!dim || data2.length !== texts.length * dim) {
    // 形状异常时降级为单条推理（与既有 in-process 兜底逻辑保持一致）
    const vectors = []
    for (const text of texts) {
      const single = await extractor(text, { pooling: 'mean', normalize: true })
      vectors.push(Array.from(single.data))
    }
    return { vectors, dim: vectors[0]?.length || 0, fallback: true }
  }

  // 用 transferable 优化：直接返回 ArrayBuffer 切片，避免在 IPC 序列化时
  // 把每个 float 当成 JS number 拷贝。父进程拿到后再切回 number[]。
  // 注意：utilityProcess.postMessage 走 structured clone，Float32Array 会被
  // 完整克隆，但比 number[] 序列化效率高一个数量级。
  const flat = new Float32Array(data2.length)
  flat.set(data2)
  return { flat, dim, count: texts.length }
}

function handleDispose() {
  extractor = null
  currentModelKey = null
  return { disposed: true }
}

async function dispatch(message) {
  const { id, type, data } = message || {}
  try {
    let result
    switch (type) {
      case 'initialize':
        result = await handleInitialize(data)
        break
      case 'embed':
        result = await handleEmbed(data)
        break
      case 'dispose':
        result = handleDispose()
        break
      case 'ping':
        result = { ok: true }
        break
      default:
        throw new Error(`未知消息类型：${type}`)
    }
    sendSuccess(id, result)
  } catch (err) {
    sendError(id, err)
  }
}

// 串行化：所有消息按到达顺序进入同一条 promise 链，worker 内不并发推理
let queue = Promise.resolve()
process.parentPort.on('message', (e) => {
  queue = queue.then(() => dispatch(e && e.data))
})

function sendSuccess(id, result) {
  process.parentPort.postMessage({ id, success: true, result })
}

function sendError(id, err) {
  const message = err && err.message ? err.message : String(err)
  const stack = err && err.stack ? err.stack : null
  process.parentPort.postMessage({ id, success: false, error: message, stack })
}

// 启动日志（父进程会通过 stdout 转发到主日志）
console.log('[EmbeddingWorker] started, pid=%d, node=%s', process.pid, process.version)
