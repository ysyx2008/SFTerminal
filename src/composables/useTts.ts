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

export interface TtsController {
  /** 喂入流式增量文本（每次传完整累积内容） */
  feedContent(fullContent: string): void
  /** 流式结束，刷出剩余缓冲区 */
  flush(): void
  /** 停止播放并清空队列 */
  stop(): void
  /** 是否正在朗读 */
  isSpeaking: ReturnType<typeof ref<boolean>>
  /** 是否已启用自动朗读 */
  isEnabled: ReturnType<typeof ref<boolean>>
  /** 切换启用状态 */
  toggle(): void
}

const SENTENCE_BOUNDARY = /(?<=[。！？.!?\n])\s*/

const MAX_SENTENCE_LENGTH = 500
const MIN_SENTENCE_LENGTH = 2

/**
 * 从 markdown 文本中提取可朗读的纯文本
 */
function stripMarkdown(text: string): string {
  let result = text
  // 移除代码块（多行）
  result = result.replace(/```[\s\S]*?```/g, '')
  // 移除行内代码
  result = result.replace(/`[^`]*`/g, '')
  // 移除图片
  result = result.replace(/!\[.*?\]\(.*?\)/g, '')
  // 移除链接保留文字
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 移除 HTML details/summary/blockquote 标签
  result = result.replace(/<\/?(?:details|summary|blockquote|strong|em|b|i|hr)[^>]*>/g, '')
  // 移除 markdown 标题标记
  result = result.replace(/^#{1,6}\s+/gm, '')
  // 移除 markdown 加粗/斜体
  result = result.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  result = result.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
  // 移除水平线
  result = result.replace(/^[-*_]{3,}\s*$/gm, '')
  // 移除列表标记
  result = result.replace(/^[\s]*[-*+]\s+/gm, '')
  result = result.replace(/^[\s]*\d+\.\s+/gm, '')
  // 合并多余空行
  result = result.replace(/\n{3,}/g, '\n\n')
  return result.trim()
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
  let processedLength = 0
  let pendingBuffer = ''
  let playbackQueue: Array<{ audio: ArrayBuffer; format: string }> = []
  let isPlaying = false
  let stopped = false
  let activeSynthesisCount = 0
  let generation = 0

  const MAX_CONCURRENT_SYNTHESIS = 3
  const synthesisQueue: string[] = []

  function getAudioContext(): AudioContext {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext()
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
    return audioContext
  }

  async function enqueueSynthesis(sentence: string): Promise<void> {
    if (stopped || !sentence.trim()) return
    if (activeSynthesisCount < MAX_CONCURRENT_SYNTHESIS) {
      doSynthesis(sentence)
    } else {
      synthesisQueue.push(sentence)
    }
  }

  async function doSynthesis(sentence: string): Promise<void> {
    const gen = generation
    activeSynthesisCount++
    try {
      const result = await window.electronAPI.tts.synthesize(sentence)
      if (gen !== generation) return
      if (result.success && result.audio) {
        playbackQueue.push({ audio: result.audio, format: result.format || 'mp3' })
        drainQueue()
      }
    } catch (err) {
      if (gen !== generation) return
      console.warn('[useTts] synthesis failed:', err)
    } finally {
      if (gen !== generation) return
      activeSynthesisCount--
      if (synthesisQueue.length > 0 && !stopped) {
        const next = synthesisQueue.shift()!
        doSynthesis(next)
      }
      if (activeSynthesisCount === 0 && playbackQueue.length === 0 && !isPlaying) {
        isSpeaking.value = false
      }
    }
  }

  async function drainQueue(): Promise<void> {
    if (isPlaying || playbackQueue.length === 0 || stopped) return
    isPlaying = true
    isSpeaking.value = true

    while (playbackQueue.length > 0 && !stopped) {
      const item = playbackQueue.shift()!
      try {
        const ctx = getAudioContext()
        const audioBuffer = await ctx.decodeAudioData(item.audio.slice(0))
        await playAudioBuffer(ctx, audioBuffer)
      } catch (err) {
        console.warn('[useTts] playback failed:', err)
      }
    }

    isPlaying = false
    if (activeSynthesisCount === 0) {
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

  function feedContent(fullContent: string): void {
    if (!isEnabled.value || stopped) return

    const stripped = stripMarkdown(fullContent)
    if (stripped.length <= processedLength) return

    const newText = stripped.slice(processedLength)
    const combined = pendingBuffer + newText

    const sentences = splitSentences(combined)
    if (sentences.length === 0) {
      pendingBuffer = combined
      processedLength = stripped.length
      return
    }

    // 最后一段可能还没结束，留在 buffer 里
    const lastSentence = sentences[sentences.length - 1]
    const endsWithBoundary = /[。！？.!?\n]\s*$/.test(combined)

    const toSynthesize = endsWithBoundary ? sentences : sentences.slice(0, -1)
    pendingBuffer = endsWithBoundary ? '' : lastSentence

    processedLength = stripped.length

    for (const sentence of toSynthesize) {
      enqueueSynthesis(sentence)
    }
  }

  function flush(): void {
    if (!isEnabled.value || stopped) return
    if (pendingBuffer.trim().length >= MIN_SENTENCE_LENGTH) {
      enqueueSynthesis(pendingBuffer.trim())
    }
    pendingBuffer = ''
  }

  function stop(): void {
    stopped = true
    generation++
    playbackQueue = []
    synthesisQueue.length = 0
    pendingBuffer = ''
    processedLength = 0
    activeSynthesisCount = 0
    isPlaying = false
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
    processedLength = 0
    pendingBuffer = ''
    playbackQueue = []
    isPlaying = false
    activeSynthesisCount = 0
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
    isSpeaking,
    isEnabled,
    toggle,
  }
}
