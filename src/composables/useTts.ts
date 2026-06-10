/**
 * TTS 语音播报 Composable
 *
 * 核心职责：
 * - 句子缓冲：监听流式文本，按句子边界切分
 * - Markdown 过滤：剥离代码块、链接语法等，只留纯文本
 * - 并行合成：检测到新句子后立即请求 TTS，不等上一句播完
 * - 串行播放：用 AudioContext 按顺序播放已合成的音频
 */
import { ref, onUnmounted } from 'vue'
import { marked } from 'marked'

export interface TtsController {
  /** 喂入流式增量文本（每次传完整累积内容） */
  feedContent(fullContent: string): void
  /** 流式结束，刷出剩余缓冲区 */
  flush(): void
  /** 停止播放并清空队列 */
  stop(): void
  /** 新任务开始：等当前播放完毕后重置状态，为新内容做准备 */
  startNewTask(): void
  /** 是否正在朗读 */
  isSpeaking: ReturnType<typeof ref<boolean>>
  /** 是否已启用自动朗读 */
  isEnabled: ReturnType<typeof ref<boolean>>
  /** 开启自动朗读（不清空已在播队列，仅解除 stop 态） */
  enable(): void
  /** 切换启用状态 */
  toggle(): void
}

const SENTENCE_BOUNDARY = /(?<=[。！？.!?\n])\s*/

const MAX_SENTENCE_LENGTH = 500
const MIN_SENTENCE_LENGTH = 2

/**
 * 复用临时 DOM 元素，避免每次调用创建/销毁
 */
let _stripDiv: HTMLDivElement | null = null
function getStripDiv(): HTMLDivElement {
  if (!_stripDiv) {
    _stripDiv = document.createElement('div')
    _stripDiv.style.display = 'none'
  }
  return _stripDiv
}

/**
 * 从 markdown 文本中提取可朗读的纯文本。
 * 利用 marked 渲染为 HTML 后通过 DOM 取 innerText，
 * 天然处理折叠块（details）、代码块、格式标记等。
 */
function stripMarkdown(text: string): string {
  // 流式中未闭合的 <details>（思考过程）需先移除再交给 marked
  const cleaned = text.replace(/<details[\s\S]*?(<\/details>|$)/g, '')

  let html: string
  try {
    html = marked.parse(cleaned, { async: false }) as string
  } catch {
    return cleaned.replace(/<[^>]*>/g, '').trim()
  }

  const div = getStripDiv()
  div.innerHTML = html

  // 移除代码块和折叠块（双保险）
  div.querySelectorAll('pre, details').forEach(el => el.remove())

  const result = (div.innerText || div.textContent || '').trim()
  div.innerHTML = ''
  return result
}

/**
 * 将文本切分为句子
 */
function splitSentences(text: string): string[] {
  if (!text) return []
  const parts = text.split(SENTENCE_BOUNDARY).filter(s => s.length >= MIN_SENTENCE_LENGTH)
  const sentences: string[] = []
  for (const part of parts) {
    if (part.length > MAX_SENTENCE_LENGTH) {
      // 超长文本按逗号/分号再切
      const subParts = part.split(/(?<=[，,；;：:])\s*/)
      let buffer = ''
      for (const sub of subParts) {
        if (buffer.length + sub.length > MAX_SENTENCE_LENGTH && buffer.length >= MIN_SENTENCE_LENGTH) {
          sentences.push(buffer.trim())
          buffer = ''
        }
        buffer += sub
      }
      if (buffer.trim().length >= MIN_SENTENCE_LENGTH) sentences.push(buffer.trim())
    } else {
      sentences.push(part.trim())
    }
  }
  return sentences
}

export function useTts(): TtsController {
  const isSpeaking = ref(false)
  const isEnabled = ref(false)

  let audioContext: AudioContext | null = null
  let pendingBuffer = ''
  let isPlaying = false
  let stopped = false
  let activeSynthesisCount = 0
  let generation = 0
  let lastRawLength = 0
  const synthesizedSentences = new Set<string>()

  const MAX_CONCURRENT_SYNTHESIS = 3
  let nextSynthesisIdx = 0
  let nextPlaybackIdx = 0
  const readyAudio = new Map<number, { audio: ArrayBuffer; format: string } | null>()
  const synthesisWaitQueue: Array<{ sentence: string; index: number }> = []

  function getAudioContext(): AudioContext {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext()
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
    return audioContext
  }

  function enqueueSynthesis(sentence: string): void {
    if (stopped || !sentence.trim()) return
    const index = nextSynthesisIdx++
    if (activeSynthesisCount < MAX_CONCURRENT_SYNTHESIS) {
      doSynthesis(sentence, index)
    } else {
      synthesisWaitQueue.push({ sentence, index })
    }
  }

  async function doSynthesis(sentence: string, index: number): Promise<void> {
    const gen = generation
    activeSynthesisCount++
    try {
      const result = await window.electronAPI.tts.synthesize(sentence)
      if (gen !== generation) return
      if (result.success && result.audio) {
        readyAudio.set(index, { audio: result.audio, format: result.format || 'mp3' })
      } else {
        readyAudio.set(index, null)
      }
      drainQueue()
    } catch (err) {
      if (gen !== generation) return
      console.warn('[useTts] synthesis failed:', err)
      readyAudio.set(index, null)
      drainQueue()
    } finally {
      if (gen === generation) {
        activeSynthesisCount--
        if (synthesisWaitQueue.length > 0 && !stopped) {
          const next = synthesisWaitQueue.shift()!
          doSynthesis(next.sentence, next.index)
        }
        if (activeSynthesisCount === 0 && readyAudio.size === 0 && !isPlaying) {
          isSpeaking.value = false
        }
      }
    }
  }

  async function drainQueue(): Promise<void> {
    if (isPlaying || stopped) return
    if (!readyAudio.has(nextPlaybackIdx)) return
    isPlaying = true
    isSpeaking.value = true

    while (readyAudio.has(nextPlaybackIdx) && !stopped) {
      const item = readyAudio.get(nextPlaybackIdx)
      readyAudio.delete(nextPlaybackIdx)
      nextPlaybackIdx++

      if (item?.audio) {
        try {
          const ctx = getAudioContext()
          const audioBuffer = await ctx.decodeAudioData(item.audio.slice(0))
          await playAudioBuffer(ctx, audioBuffer)
        } catch (err) {
          console.warn('[useTts] playback failed:', err)
        }
      }
    }

    isPlaying = false
    if (activeSynthesisCount === 0 && readyAudio.size === 0) {
      isSpeaking.value = false
    }
  }

  function playAudioBuffer(ctx: AudioContext, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) { resolve(); return }
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.onended = () => resolve()
      source.start(0)
    })
  }

  function resetSynthesisState(): void {
    readyAudio.clear()
    synthesisWaitQueue.length = 0
    nextSynthesisIdx = 0
    nextPlaybackIdx = 0
    activeSynthesisCount = 0
    isPlaying = false
    pendingBuffer = ''
    lastRawLength = 0
    synthesizedSentences.clear()
  }

  function startNewTask(): void {
    generation++
    resetSynthesisState()

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {})
      audioContext = null
    }
    window.electronAPI.tts.stop().catch(() => {})
    isSpeaking.value = false
  }

  function feedContent(fullContent: string): void {
    if (!isEnabled.value || stopped) return

    // 原始内容变短 → 新的 message step 开始，重置原始长度追踪
    if (fullContent.length < lastRawLength) {
      lastRawLength = 0
    }
    // 原始内容未增长 → 无新内容，跳过
    if (fullContent.length <= lastRawLength) return
    lastRawLength = fullContent.length

    const stripped = stripMarkdown(fullContent)
    const allSentences = splitSentences(stripped)
    if (allSentences.length === 0) return

    const endsWithBoundary = /[。！？.!?\n]\s*$/.test(stripped)
    const completeSentences = endsWithBoundary ? allSentences : allSentences.slice(0, -1)
    pendingBuffer = endsWithBoundary ? '' : allSentences[allSentences.length - 1]

    for (const sentence of completeSentences) {
      if (!synthesizedSentences.has(sentence)) {
        synthesizedSentences.add(sentence)
        enqueueSynthesis(sentence)
      }
    }
  }

  function flush(): void {
    if (!isEnabled.value || stopped) return
    const text = pendingBuffer.trim()
    if (text.length >= MIN_SENTENCE_LENGTH && !synthesizedSentences.has(text)) {
      synthesizedSentences.add(text)
      enqueueSynthesis(text)
    }
    pendingBuffer = ''
  }

  function stop(): void {
    stopped = true
    generation++
    resetSynthesisState()
    isSpeaking.value = false

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => {})
      audioContext = null
    }

    window.electronAPI.tts.stop().catch(() => {})
  }

  function reset(): void {
    stopped = false
    generation++
    resetSynthesisState()
  }

  function enable(): void {
    stopped = false
    isEnabled.value = true
  }

  function toggle(): void {
    isEnabled.value = !isEnabled.value
    if (!isEnabled.value) {
      stop()
    } else {
      reset()
    }
  }

  onUnmounted(() => {
    stop()
  })

  return {
    feedContent: (fullContent: string) => {
      if (stopped) reset()
      feedContent(fullContent)
    },
    flush,
    stop,
    startNewTask,
    isSpeaking,
    isEnabled,
    enable,
    toggle,
  }
}
