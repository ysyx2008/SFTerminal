/**
 * 语音识别 Composable
 * 使用 sherpa-onnx + Paraformer 模型
 */
import { ref, computed, onUnmounted } from 'vue'

export interface SpeechRecognitionStatus {
  initialized: boolean
  modelLoaded: boolean
  modelId: string | null
  error?: string
}

export interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
}

/**
 * 简单的线性插值重采样
 * @param input 输入音频数据
 * @param fromSampleRate 原始采样率
 * @param toSampleRate 目标采样率
 */
function resampleAudio(input: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
  if (fromSampleRate === toSampleRate) {
    return new Float32Array(input)
  }
  
  const ratio = fromSampleRate / toSampleRate
  const outputLength = Math.round(input.length / ratio)
  const output = new Float32Array(outputLength)
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio
    const srcIndexFloor = Math.floor(srcIndex)
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1)
    const fraction = srcIndex - srcIndexFloor
    
    // 线性插值
    output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction
  }
  
  return output
}

// 全局共享状态（所有 useSpeechRecognition 实例共用）
const audioAvailable = ref(true)
const isModelReady = ref(false)
/** 模型包是否已安装（与 isModelReady 不同：后者表示 worker 已加载）。null = 尚未查询 */
const modelAvailable = ref<boolean | null>(null)
let _audioChecked = false
let _modelInitPromise: Promise<boolean> | null = null

export const SPEECH_PACK_NOT_INSTALLED = 'SPEECH_PACK_NOT_INSTALLED'

/**
 * 全局音频设备检测（只执行一次真正的设备枚举）
 */
export async function checkAudioDevicesGlobal(): Promise<boolean> {
  if (_audioChecked) return audioAvailable.value
  _audioChecked = true
  try {
    if (!navigator.mediaDevices?.enumerateDevices) {
      audioAvailable.value = false
      return false
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    const hasInput = devices.some(d => d.kind === 'audioinput')
    audioAvailable.value = hasInput
    return hasInput
  } catch {
    audioAvailable.value = false
    return false
  }
}

/** 查询模型包是否已安装（可重复调用以刷新状态） */
export async function refreshSpeechPackAvailability(): Promise<boolean> {
  try {
    const info = await window.electronAPI.speech.getModelInfo()
    modelAvailable.value = Boolean(info.available)
    if (!info.available) {
      isModelReady.value = false
    }
    return modelAvailable.value
  } catch {
    modelAvailable.value = false
    return false
  }
}

/**
 * 全局语音模型初始化（幂等，多次调用共享同一 Promise）
 */
export async function initSpeechGlobal(): Promise<boolean> {
  if (isModelReady.value) return true
  if (_modelInitPromise) return _modelInitPromise
  _modelInitPromise = _doInitSpeech()
  return _modelInitPromise
}

async function _doInitSpeech(): Promise<boolean> {
  try {
    const modelInfo = await window.electronAPI.speech.getModelInfo()
    modelAvailable.value = Boolean(modelInfo.available)
    if (!modelInfo.available) return false

    const ready = await window.electronAPI.speech.isReady()
    if (ready) {
      isModelReady.value = true
      return true
    }

    const result = await window.electronAPI.speech.initialize()
    if (!result.success) {
      if (result.error === SPEECH_PACK_NOT_INSTALLED) {
        modelAvailable.value = false
      }
      return false
    }

    isModelReady.value = true
    return true
  } catch {
    return false
  } finally {
    _modelInitPromise = null
  }
}

export function useSpeechRecognition() {
  // 实例状态（每个 AiPanel 独立）
  const isRecording = ref(false)
  const isTranscribing = ref(false)
  const isInitializing = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<TranscriptionResult | null>(null)

  // 录音相关
  let audioContext: AudioContext | null = null
  let audioChunks: Float32Array[] = []
  let mediaStream: MediaStream | null = null
  let captureNode: ScriptProcessorNode | null = null
  let startAborted = false

  // 计算属性
  const canRecord = computed(() => audioAvailable.value && isModelReady.value && !isRecording.value && !isTranscribing.value)
  const isProcessing = computed(() => isRecording.value || isTranscribing.value || isInitializing.value)

  /**
   * 检测系统是否有可用的音频输入设备（委托给全局检测）
   */
  async function checkAudioDevices(): Promise<boolean> {
    return checkAudioDevicesGlobal()
  }

  /**
   * 检查并初始化语音识别服务
   */
  async function checkAndInitialize(): Promise<boolean> {
    console.debug('[useSpeechRecognition] checkAndInitialize called')
    isInitializing.value = true
    error.value = null
    try {
      const available = await refreshSpeechPackAvailability()
      if (!available) {
        error.value = SPEECH_PACK_NOT_INSTALLED
        return false
      }
      const success = await initSpeechGlobal()
      if (!success) {
        error.value = modelAvailable.value ? '语音模型初始化失败' : SPEECH_PACK_NOT_INSTALLED
      }
      return success
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化失败'
      return false
    } finally {
      isInitializing.value = false
    }
  }

  function releaseMediaResources(): void {
    if (captureNode) {
      try {
        captureNode.onaudioprocess = null
        captureNode.disconnect()
      } catch {
        // ignore
      }
      captureNode = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => {})
      audioContext = null
    }
  }

  /**
   * 开始录音
   */
  async function startRecording(): Promise<boolean> {
    console.log('[useSpeechRecognition] startRecording called')
    if (isRecording.value) {
      console.log('[useSpeechRecognition] Already recording, skipping')
      return false
    }

    try {
      error.value = null
      audioChunks = []
      startAborted = false

      // 确保模型已初始化
      if (!isModelReady.value) {
        console.log('[useSpeechRecognition] Model not ready, initializing...')
        const initialized = await checkAndInitialize()
        console.log('[useSpeechRecognition] Initialize result:', initialized, 'error:', error.value)
        if (!initialized) return false
        if (startAborted) {
          releaseMediaResources()
          return false
        }
      }

      // 请求麦克风权限并获取音频流
      // 注意：Windows 上某些设备可能不支持指定的采样率约束
      // 使用 ideal 而不是硬性约束，让浏览器选择最接近的设置
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: { ideal: 16000 },
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true
          }
        })
      } catch (mediaErr) {
        // 如果 ideal 约束也失败，尝试使用最基本的约束
        console.warn('[useSpeechRecognition] 使用 ideal 约束失败，尝试基本约束:', mediaErr)
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true
        })
      }

      if (startAborted) {
        releaseMediaResources()
        return false
      }

      // 创建 AudioContext 用于处理音频数据
      // 注意：Windows 上可能无法强制指定采样率，需要后续重采样
      const targetSampleRate = 16000
      try {
        audioContext = new AudioContext({ sampleRate: targetSampleRate })
      } catch {
        // 如果指定采样率失败，使用默认采样率
        audioContext = new AudioContext()
        console.warn(`[useSpeechRecognition] 无法创建 ${targetSampleRate}Hz AudioContext，使用默认: ${audioContext.sampleRate}Hz`)
      }
      const source = audioContext.createMediaStreamSource(mediaStream)
      const actualSampleRate = audioContext.sampleRate

      // 用 ScriptProcessorNode 捕获音频数据。详见文件顶部注释——AudioWorkletNode
      // 在 packaged 渲染进程下会出现 inputs[0][0] 全零的边角问题。
      captureNode = audioContext.createScriptProcessor(4096, 1, 1)

      captureNode.onaudioprocess = (e) => {
        if (!isRecording.value) return
        const inputData = e.inputBuffer.getChannelData(0)
        if (actualSampleRate !== targetSampleRate) {
          audioChunks.push(resampleAudio(inputData, actualSampleRate, targetSampleRate))
        } else {
          // inputBuffer 会被 audio engine 复用，必须立刻拷一份
          audioChunks.push(new Float32Array(inputData))
        }
      }

      source.connect(captureNode)
      // ScriptProcessorNode 必须接到 destination 才会被持续 callback。
      // 它的输出端没人写值，所以不会有任何声音被路由到扬声器。
      captureNode.connect(audioContext.destination)

      isRecording.value = true
      return true
    } catch (err) {
      releaseMediaResources()
      error.value = err instanceof Error ? err.message : '无法访问麦克风'
      return false
    }
  }

  /**
   * 停止录音并转录
   */
  async function stopRecording(): Promise<TranscriptionResult | null> {
    startAborted = true

    if (!isRecording.value) {
      releaseMediaResources()
      audioChunks = []
      return null
    }

    isRecording.value = false

    try {
      releaseMediaResources()

      if (audioChunks.length === 0) {
        error.value = '未录制到音频'
        return null
      }

      const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const mergedData = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of audioChunks) {
        mergedData.set(chunk, offset)
        offset += chunk.length
      }

      // 兜底诊断：chunk 数 / 总采样数 / 大致音量。识别异常时可一眼看出
      // 采集节点是否在驱动（chunk 数为 0 或音频全零都意味着采集没拿到输入）。
      let peak = 0
      for (let i = 0; i < mergedData.length; i++) {
        const v = Math.abs(mergedData[i])
        if (v > peak) peak = v
      }
      console.debug(
        `[useSpeechRecognition] captured chunks=${audioChunks.length}, samples=${totalLength}, peak=${peak.toFixed(4)}`
      )

      isTranscribing.value = true
      
      // 将 Float32Array 转为普通数组传递给 IPC
      const audioArray = Array.from(mergedData)
      
      const result = await window.electronAPI.speech.transcribe(audioArray, 16000)

      if (!result.success) {
        error.value = result.error || '转录失败'
        return null
      }

      lastResult.value = result.result || null
      return result.result || null
    } catch (err) {
      error.value = err instanceof Error ? err.message : '转录失败'
      return null
    } finally {
      isTranscribing.value = false
      audioChunks = []
    }
  }

  /**
   * 取消录音（也能中止尚未完成的 startRecording）
   */
  function cancelRecording(): void {
    startAborted = true
    isRecording.value = false
    audioChunks = []
    releaseMediaResources()
  }

  /**
   * 获取服务状态
   */
  async function getStatus(): Promise<SpeechRecognitionStatus> {
    return await window.electronAPI.speech.getStatus()
  }

  // 清理
  onUnmounted(() => {
    cancelRecording()
  })

  return {
    // 状态
    isRecording,
    isTranscribing,
    isInitializing,
    isModelReady,
    modelAvailable,
    audioAvailable,
    isProcessing,
    canRecord,
    error,
    lastResult,

    // 方法
    checkAudioDevices,
    checkAndInitialize,
    refreshSpeechPackAvailability,
    startRecording,
    stopRecording,
    cancelRecording,
    getStatus
  }
}
