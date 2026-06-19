<script setup lang="ts">
import { computed, nextTick, ref, useSlots, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, Square, ArrowUp, Check, Mic, MicOff, Loader2, Volume2 } from 'lucide-vue-next'
import { useMentions } from '../composables/useMentions'
import { toast } from '../composables/useToast'
import { useComposerQuoteStore } from '../stores/composer-quote'
import type { ComposerQuoteSnippet } from '../stores/composer-quote'
import type { ParsedDocument } from '../stores/terminal'
import type { ParsingDocument } from '../composables/useDocumentUpload'

interface ContextStats {
  tokenEstimate: number
  maxTokens: number
  percentage: number
  cacheHitRate?: number
  effectiveModel?: string
}

interface PendingImage {
  id: string
  name: string
  dataUrl: string
}

interface UploadedDoc {
  filename: string
  fileType: string
  fileSize: number
  error?: string
}

const props = defineProps<{
  currentTabId: string
  visible?: boolean
  contextStats: ContextStats
  cacheBarWidth: number
  uploadedDocs: UploadedDoc[]
  parsingDocs: ParsingDocument[]
  pendingImages: PendingImage[]
  isAttaching: boolean
  isAgentRunning: boolean
  isLoading: boolean
  canSendEmpty: boolean
  hasImages: boolean
  isRecording: boolean
  isTranscribing: boolean
  isPushToTalk: boolean
  audioAvailable: boolean
  isSpeechInitializing: boolean
  formatFileSize: (size?: number) => string
  openImagePreview: (url: string) => void
  removeImage: (id: string) => void
  selectAttachment: () => void
  removeUploadedDoc: (index: number) => void
  clearUploadedDocs: () => void
  handlePaste: (event: ClipboardEvent) => void
  handleRecordClick: () => void
  stopGeneration: () => void
  abortAgent: () => void
  ttsIsSpeaking: boolean
  ttsStop: () => void
  submitMessage: (message: string) => void | Promise<void>
  submitEmptyMessage: () => void | Promise<void>
  clearTabError: () => void
  /** 嵌入欢迎页等非面板场景：去掉顶部分割线，使用独立圆角容器 */
  embedded?: boolean
  /** 覆盖默认 placeholder（如欢迎页） */
  placeholder?: string
}>()

const { t } = useI18n()

const quoteStore = useComposerQuoteStore()
const quoteSnippets = computed(() => quoteStore.getSnippets(props.currentTabId))

const composerPlaceholder = computed(
  () =>
    props.placeholder ??
    (props.isAgentRunning ? t('ai.inputPlaceholderSupplement') : t('ai.inputPlaceholderAgent'))
)

/** embedded 模式：有附件时才显示外层统一容器，避免空态双层边框 */
const hasComposerAttachments = computed(
  () =>
    props.parsingDocs.length > 0 ||
    props.uploadedDocs.length > 0 ||
    quoteSnippets.value.length > 0 ||
    props.pendingImages.length > 0
)

/** 输入框无文字时，有图片或引用摘录也可发送 */
const canSubmitMessage = computed(
  () => !!inputText.value.trim() || props.hasImages || quoteSnippets.value.length > 0
)

function removeQuoteSnippet(id: string) {
  quoteStore.removeSnippet(props.currentTabId, id)
}

function snippetChipSummary(s: ComposerQuoteSnippet): string {
  const count = [...s.excerpt].length
  if (s.quoteOrigin === 'terminal') {
    return t('ai.quoteSnippetChipTerminal', { label: s.label, count })
  }
  if (s.sourceLinesAccurate && s.startLine != null && s.endLine != null) {
    return t('ai.quoteSnippetChipRange', {
      label: s.label,
      start: s.startLine,
      end: s.endLine,
      count
    })
  }
  return t('ai.quoteSnippetChipPreview', { label: s.label, count })
}

/** 发送时附加给模型：带行号的完整摘录 */
function formatQuotesAppendix(snippets: ComposerQuoteSnippet[]): string {
  if (snippets.length === 0) return ''
  const blocks: string[] = [t('ai.quoteSnippetAppendixIntro')]
  snippets.forEach((s, i) => {
    const n = i + 1
    const range =
      s.quoteOrigin === 'terminal'
        ? t('ai.quoteSnippetRangeTerminal')
        : s.sourceLinesAccurate && s.startLine != null && s.endLine != null
          ? t('ai.quoteSnippetRangeFileLines', { start: s.startLine, end: s.endLine })
          : t('ai.quoteSnippetRelativeLinesNote')
    blocks.push(`### ${t('ai.quoteSnippetAppendixHeading', { n, label: s.label, range })}`)
    if (s.sourcePath) {
      blocks.push(`${t('ai.quoteSnippetAppendixPath')}: ${s.sourcePath}`)
    }
    if (s.quoteOrigin === 'terminal') {
      blocks.push(t('ai.quoteSnippetAppendixTerminalDisclaimer'))
    } else if (!s.sourceLinesAccurate) {
      blocks.push(t('ai.quoteSnippetAppendixPreviewDisclaimer'))
    }
    blocks.push('')
    const lines = s.excerpt.split('\n')
    lines.forEach((line, idx) => {
      const num =
        s.sourceLinesAccurate && s.startLine != null ? s.startLine + idx : idx + 1
      blocks.push(`${String(num).padStart(5, ' ')} | ${line}`)
    })
  })
  return blocks.join('\n')
}

const inputText = ref('')
const isComposing = ref(false)
const mentionInputEl = ref<HTMLTextAreaElement | null>(null)
const mentionListEl = ref<HTMLDivElement | null>(null)
const currentTabIdRef = computed(() => props.currentTabId)
const uploadedDocsRef = computed(() => props.uploadedDocs as ParsedDocument[])

const {
  showMenu: showMentionMenu,
  menuType: mentionMenuType,
  suggestions: mentionSuggestions,
  selectedIndex: mentionSelectedIndex,
  isLoading: isMentionLoading,
  hasMore: mentionHasMore,
  totalCount: mentionTotalCount,
  currentDir: mentionCurrentDir,
  detectTrigger,
  selectSuggestion: doSelectSuggestion,
  clearMentions,
  closeMenu: closeMentionMenu,
  goBack: mentionGoBack,
  handleKeyDown: handleMentionKeyDown,
  expandMentions
} = useMentions(inputText, currentTabIdRef, uploadedDocsRef)

const focusInput = () => {
  mentionInputEl.value?.focus()
}

const adjustTextareaHeight = () => {
  const textarea = mentionInputEl.value
  if (!textarea) return

  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
}

const appendText = (text: string) => {
  if (!text.trim()) return
  inputText.value = inputText.value
    ? `${inputText.value} ${text}`.trim()
    : text
  nextTick(() => {
    focusInput()
    adjustTextareaHeight()
  })
}

const setText = (text: string) => {
  inputText.value = text
  nextTick(() => {
    focusInput()
    adjustTextareaHeight()
  })
}

const clearText = () => {
  inputText.value = ''
  nextTick(adjustTextareaHeight)
}

// 一次性脉冲提示：让用户从场景卡片填入 prompt 后，注意到输入框已就绪。
// 用户从欢迎区点击场景卡片 → setText 把 prompt 填进来 → flashHint 触发蓝色
// outline 脉冲 ~1.5s 引导用户「这就是输入框，按 Enter 就发送」。
const isFlashHint = ref(false)
let flashHintTimer: ReturnType<typeof setTimeout> | null = null

const flashHint = () => {
  if (flashHintTimer) {
    clearTimeout(flashHintTimer)
    flashHintTimer = null
  }
  // 先关再开，确保 CSS 动画从头重放（连续点击场景卡片时也能每次脉冲）
  isFlashHint.value = false
  nextTick(() => {
    isFlashHint.value = true
    flashHintTimer = setTimeout(() => {
      isFlashHint.value = false
      flashHintTimer = null
    }, 1500)
  })
}

watch(() => props.visible, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      focusInput()
      adjustTextareaHeight()
    })
  }
}, { immediate: true })

watch(
  () => quoteSnippets.value.length,
  (len, prevLen) => {
    if (len > (prevLen ?? 0)) {
      nextTick(() => {
        focusInput()
        adjustTextareaHeight()
      })
    }
  }
)

watch(inputText, () => {
  nextTick(adjustTextareaHeight)
})

watch(mentionSelectedIndex, (newIndex) => {
  nextTick(() => {
    if (!mentionListEl.value) return
    const items = mentionListEl.value.querySelectorAll('.mention-item')
    const selectedItem = items[newIndex] as HTMLElement | undefined
    selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
})

const setMentionSelectedIndex = (index: number) => {
  mentionSelectedIndex.value = index
}

const handleInputChange = (event: Event) => {
  const textarea = event.target as HTMLTextAreaElement
  const cursorPos = textarea.selectionStart || 0
  detectTrigger(textarea.value, cursorPos)
  adjustTextareaHeight()
}

const handleInputBlur = () => {
  setTimeout(() => closeMentionMenu(), 150)
}

const selectSuggestion = (suggestion: typeof mentionSuggestions.value[0]) => {
  doSelectSuggestion(suggestion)
  nextTick(() => {
    focusInput()
    adjustTextareaHeight()
  })
}

const handleInputKeyDown = (event: KeyboardEvent) => {
  if (showMentionMenu.value) {
    const handled = handleMentionKeyDown(event)
    if (handled) return
  }

  if (event.key === 'Enter' && !event.shiftKey && !isComposing.value) {
    event.preventDefault()
    void handleSend()
  }
}

const handleSend = async () => {
  if (isComposing.value) return
  if (props.isAttaching) {
    toast.warning(t('ai.parsingPleaseWait'))
    return
  }
  closeMentionMenu()

  const quotesSnapshot = [...quoteStore.getSnippets(props.currentTabId)]

  if (
    !inputText.value.trim() &&
    !props.hasImages &&
    quotesSnapshot.length === 0 &&
    props.canSendEmpty &&
    props.isAgentRunning
  ) {
    props.clearTabError()
    await props.submitEmptyMessage()
    return
  }

  if (!inputText.value.trim() && props.hasImages) {
    inputText.value = t('ai.describeImage')
  }

  if (!inputText.value.trim() && !props.hasImages && quotesSnapshot.length === 0) {
    return
  }

  const rawInput = inputText.value.trim()
  inputText.value = ''
  props.clearTabError()

  await new Promise(resolve => setTimeout(resolve, 0))

  const { contextParts } = await expandMentions(rawInput)
  let mergedUser =
    contextParts.length > 0 ? `${rawInput}\n\n${contextParts.join('\n\n')}` : rawInput

  if (!mergedUser.trim() && quotesSnapshot.length > 0) {
    mergedUser = t('ai.quoteOnlyPrompt')
  }

  const appendix = formatQuotesAppendix(quotesSnapshot)
  const finalMessage = appendix ? `${mergedUser}\n\n${appendix}` : mergedUser

  clearMentions()
  quoteStore.clearSnippets(props.currentTabId)

  await new Promise(resolve => setTimeout(resolve, 0))
  await props.submitMessage(finalMessage)
}

const getDocIcon = (fileType: string) => {
  if (fileType === 'pdf') return '📕'
  if (fileType === 'docx' || fileType === 'doc') return '📘'
  return '📄'
}

const parsingSummary = computed(() => {
  const total = props.parsingDocs.length
  const done = props.parsingDocs.filter(doc => doc.status === 'completed' || doc.status === 'failed').length
  return t('ai.parsingDocsSummary', { done, total })
})

const getParsePhaseLabel = (doc: ParsingDocument) => {
  if (doc.error) return doc.error
  if (doc.current !== undefined && doc.total !== undefined && doc.total > 0) {
    return `${t(`ai.documentParsePhase.${doc.phase}`)} ${doc.current}/${doc.total}`
  }
  return doc.message || t(`ai.documentParsePhase.${doc.phase}`)
}

const slots = useSlots()
const isTwoRow = computed(() => !!slots['footer-left'])

defineExpose({
  focusInput,
  appendText,
  setText,
  clearText,
  flashHint,
  getText: () => inputText.value
})

const handleSendClick = (event: MouseEvent) => {
  event.preventDefault()
  void handleSend()
}
</script>

<template>
  <div
    class="composer-root"
    :class="{
      'composer-root-embedded': embedded,
      'composer-root-embedded-filled': embedded && hasComposerAttachments
    }"
  >
  <div v-if="parsingDocs.length > 0" class="parsing-docs">
    <div class="uploaded-docs-header">
      <span class="uploaded-docs-title">{{ t('ai.parsingDocs') }} · {{ parsingSummary }}</span>
    </div>
    <div class="parsing-docs-list">
      <div
        v-for="doc in parsingDocs"
        :key="`${doc.requestId}-${doc.fileIndex}`"
        class="parsing-doc-item"
        :class="{ 'has-error': doc.status === 'failed', completed: doc.status === 'completed' }"
      >
        <div class="parsing-doc-main">
          <span class="doc-icon">{{ doc.status === 'completed' ? '✓' : doc.status === 'failed' ? '⚠' : '📄' }}</span>
          <span class="doc-name" :title="doc.filename">{{ doc.filename }}</span>
          <span class="doc-size">{{ formatFileSize(doc.fileSize) }}</span>
          <span class="parse-percent">{{ Math.round(doc.percent) }}%</span>
        </div>
        <div class="parse-progress-track">
          <div class="parse-progress-bar" :style="{ width: Math.max(4, Math.min(100, doc.percent)) + '%' }"></div>
        </div>
        <div class="parse-phase" :title="getParsePhaseLabel(doc)">
          {{ getParsePhaseLabel(doc) }}
        </div>
      </div>
    </div>
  </div>

  <div v-if="uploadedDocs.length > 0" class="uploaded-docs">
    <div class="uploaded-docs-header">
      <span class="uploaded-docs-title">📎 {{ t('ai.uploadedDocs') }} ({{ uploadedDocs.length }})</span>
      <button class="btn-clear-docs" @click="clearUploadedDocs" :title="t('ai.clearDocs')">
        <X :size="12" />
      </button>
    </div>
    <div class="uploaded-docs-list">
      <div
        v-for="(doc, index) in uploadedDocs"
        :key="index"
        class="uploaded-doc-item"
        :class="{ 'has-error': doc.error }"
      >
        <span class="doc-icon">{{ getDocIcon(doc.fileType) }}</span>
        <span class="doc-name" :title="doc.filename">{{ doc.filename }}</span>
        <span class="doc-size">{{ formatFileSize(doc.fileSize) }}</span>
        <span v-if="doc.error" class="doc-error" :data-tooltip="doc.error">⚠️</span>
        <button class="btn-remove-doc" @click="removeUploadedDoc(index)" :title="t('ai.removeDoc')">
          <X :size="10" />
        </button>
      </div>
    </div>
  </div>

  <div v-if="quoteSnippets.length > 0" class="composer-quote-snips">
    <div class="composer-quote-snips-header">
      <span class="composer-quote-snips-title">{{ t('ai.quoteSnippetsSection') }}</span>
    </div>
    <div class="composer-quote-snips-list">
      <div v-for="s in quoteSnippets" :key="s.id" class="composer-quote-chip" :title="snippetChipSummary(s)">
        <span class="composer-quote-chip-label">{{ snippetChipSummary(s) }}</span>
        <button type="button" class="composer-quote-chip-remove" @click="removeQuoteSnippet(s.id)" :title="t('ai.quoteSnippetRemove')">
          <X :size="12" />
        </button>
      </div>
    </div>
  </div>

  <div class="ai-input" :class="{ 'ai-input-embedded': embedded }">
    <div v-if="contextStats.tokenEstimate > 0" class="context-mini">
      <template v-if="cacheBarWidth > 0">
        <div class="context-mini-bar cached" :style="{ width: cacheBarWidth + '%' }"></div>
        <div
          class="context-mini-bar"
          :class="{ warning: contextStats.percentage > 60, danger: contextStats.percentage > 85 }"
          :style="{ left: cacheBarWidth + '%', width: (contextStats.percentage - cacheBarWidth) + '%' }"
        ></div>
      </template>
      <div
        v-else
        class="context-mini-bar"
        :class="{ warning: contextStats.percentage > 60, danger: contextStats.percentage > 85 }"
        :style="{ width: contextStats.percentage + '%' }"
      ></div>
      <span class="context-mini-tip">
        <template v-if="contextStats.effectiveModel">{{ contextStats.effectiveModel }} · </template>{{ t('ai.context') }}: {{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K ({{ contextStats.percentage }}%)<template v-if="contextStats.cacheHitRate !== undefined"> · Cache {{ contextStats.cacheHitRate }}%</template>
      </span>
    </div>

    <div v-if="pendingImages.length > 0" class="image-preview-strip">
      <div v-for="img in pendingImages" :key="img.id" class="image-preview-item">
        <img :src="img.dataUrl" :alt="img.name" class="image-thumbnail" @click="openImagePreview(img.dataUrl)" />
        <button class="image-remove-btn" @click="removeImage(img.id)" :title="t('ai.removeImage')">
          <X :size="12" />
        </button>
      </div>
    </div>

    <div class="input-container" :class="{ 'flash-hint': isFlashHint, 'input-container-two-row': isTwoRow }">
      <button
        v-if="!isTwoRow"
        class="upload-btn"
        :disabled="isAttaching"
        :title="t('ai.attach')"
        @click="selectAttachment"
      >
        <span v-if="isAttaching" class="upload-spinner"></span>
        <Plus v-else :size="18" />
      </button>

      <textarea
        ref="mentionInputEl"
        v-model="inputText"
        :placeholder="composerPlaceholder"
        rows="1"
        @input="handleInputChange"
        @keydown="handleInputKeyDown"
        @paste="handlePaste"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @blur="handleInputBlur"
      ></textarea>

      <div v-if="showMentionMenu" class="mention-menu">
        <div v-if="mentionMenuType === null" class="mention-menu-header">
          {{ t('mentions.selectCommand') }}
        </div>
        <div v-else class="mention-menu-header">
          <span v-if="mentionMenuType === 'file'">📄 {{ t('mentions.file') }}</span>
          <span v-else-if="mentionMenuType === 'docs'">📚 {{ t('mentions.docs') }}</span>
          <span v-if="mentionCurrentDir" class="mention-path" :title="mentionCurrentDir">{{ mentionCurrentDir }}</span>
        </div>

        <div v-if="isMentionLoading" class="mention-loading">
          <span class="mention-spinner"></span>
          {{ t('common.loading') }}
        </div>
        <div v-else-if="mentionSuggestions.length === 0" class="mention-empty">
          {{ t('mentions.noResults') }}
        </div>
        <div v-else ref="mentionListEl" class="mention-list">
          <div
            v-for="(suggestion, index) in mentionSuggestions"
            :key="suggestion.id"
            class="mention-item"
            :class="{ active: index === mentionSelectedIndex }"
            @mousedown.prevent="selectSuggestion(suggestion)"
            @mouseenter="setMentionSelectedIndex(index)"
          >
            <span class="mention-icon">{{ suggestion.icon }}</span>
            <div class="mention-content">
              <span class="mention-label">{{ suggestion.label }}</span>
              <span v-if="suggestion.description" class="mention-desc">{{ suggestion.description }}</span>
            </div>
          </div>
          <div v-if="mentionHasMore" class="mention-more">
            {{ t('mentions.moreItems', { count: mentionTotalCount - 50 }) }}
          </div>
        </div>
        <div class="mention-hint">
          <span
            v-if="mentionMenuType !== null"
            class="mention-back-btn"
            @mousedown.prevent="mentionGoBack(); focusInput()"
          >
            ← {{ t('mentions.back') }}
          </span>
          <span class="mention-hint-keys">
            <span>↑↓</span> {{ t('mentions.navigate') }}
            <span>Tab/Enter</span> {{ t('mentions.select') }}
            <span>Esc</span> {{ t('mentions.close') }}
          </span>
        </div>
      </div>

      <!-- 两行模式底栏 -->
      <div v-if="isTwoRow" class="input-bottom-bar">
        <div class="input-footer-left">
          <button
            class="upload-btn"
            :disabled="isAttaching"
            :title="t('ai.attach')"
            @click="selectAttachment"
          >
            <span v-if="isAttaching" class="upload-spinner"></span>
            <Plus v-else :size="18" />
          </button>
          <slot name="footer-left" />
        </div>
        <div class="input-footer-right">
          <button
            v-if="!isLoading || isAgentRunning"
            class="voice-btn"
            :class="{ recording: isRecording, transcribing: isTranscribing, ptt: isPushToTalk, unavailable: !audioAvailable }"
            :disabled="!audioAvailable || isTranscribing || isSpeechInitializing"
            :title="!audioAvailable ? t('ai.noAudioDevice') : isRecording ? t('ai.stopRecording') : (isTranscribing ? t('ai.transcribing') : t('ai.startRecording'))"
            @click="handleRecordClick"
          >
            <Loader2 v-if="isTranscribing || isSpeechInitializing" :size="18" class="spin" />
            <MicOff v-else-if="isRecording || !audioAvailable" :size="18" />
            <Mic v-else :size="18" />
          </button>
          <button v-if="ttsIsSpeaking" class="tts-stop-btn" @click="ttsStop" :title="t('ai.stopTts')">
            <Volume2 :size="18" class="tts-speaking-icon" />
          </button>
          <button v-if="isLoading && !isAgentRunning" class="stop-btn" @click="stopGeneration" :title="t('ai.stopGeneration')">
            <Square :size="16" fill="currentColor" />
          </button>
          <button v-else-if="isAgentRunning && canSubmitMessage" class="send-btn send-btn-supplement" :disabled="isAttaching" :title="t('ai.sendSupplement')" @click="handleSendClick">
            <ArrowUp :size="18" />
          </button>
          <button v-else-if="isAgentRunning && canSendEmpty" class="send-btn send-btn-default" :disabled="isAttaching" :title="t('ai.useDefault')" @click="handleSendClick">
            <Check :size="18" />
          </button>
          <button v-else-if="isAgentRunning" class="stop-btn" @click="abortAgent" :title="t('ai.stopAgent')">
            <Square :size="16" fill="currentColor" />
          </button>
          <button v-else class="send-btn send-btn-agent" :disabled="isAttaching || !canSubmitMessage" :title="t('ai.executeTask')" @click="handleSendClick">
            <ArrowUp :size="18" />
          </button>
        </div>
      </div>

      <!-- 单行模式右侧按钮 -->
      <template v-else>
        <slot name="inner-right" />

        <button
          v-if="!isLoading || isAgentRunning"
          class="voice-btn"
          :class="{ recording: isRecording, transcribing: isTranscribing, ptt: isPushToTalk, unavailable: !audioAvailable }"
          :disabled="!audioAvailable || isTranscribing || isSpeechInitializing"
          :title="!audioAvailable ? t('ai.noAudioDevice') : isRecording ? t('ai.stopRecording') : (isTranscribing ? t('ai.transcribing') : t('ai.startRecording'))"
          @click="handleRecordClick"
        >
          <Loader2 v-if="isTranscribing || isSpeechInitializing" :size="18" class="spin" />
          <MicOff v-else-if="isRecording || !audioAvailable" :size="18" />
          <Mic v-else :size="18" />
        </button>

        <button
          v-if="ttsIsSpeaking"
          class="tts-stop-btn"
          @click="ttsStop"
          :title="t('ai.stopTts')"
        >
          <Volume2 :size="18" class="tts-speaking-icon" />
        </button>

        <button
          v-if="isLoading && !isAgentRunning"
          class="stop-btn"
          @click="stopGeneration"
          :title="t('ai.stopGeneration')"
        >
          <Square :size="16" fill="currentColor" />
        </button>
        <button
          v-else-if="isAgentRunning && canSubmitMessage"
          class="send-btn send-btn-supplement"
          :disabled="isAttaching"
          :title="t('ai.sendSupplement')"
          @click="handleSendClick"
        >
          <ArrowUp :size="18" />
        </button>
        <button
          v-else-if="isAgentRunning && canSendEmpty"
          class="send-btn send-btn-default"
          :disabled="isAttaching"
          :title="t('ai.useDefault')"
          @click="handleSendClick"
        >
          <Check :size="18" />
        </button>
        <button
          v-else-if="isAgentRunning"
          class="stop-btn"
          @click="abortAgent"
          :title="t('ai.stopAgent')"
        >
          <Square :size="16" fill="currentColor" />
        </button>
        <button
          v-else
          class="send-btn send-btn-agent"
          :disabled="isAttaching || !canSubmitMessage"
          :title="t('ai.executeTask')"
          @click="handleSendClick"
        >
          <ArrowUp :size="18" />
        </button>
      </template>
    </div>
  </div>
  </div>
</template>

<style scoped>
.context-mini {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  cursor: help;
}

.context-mini::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--bg-tertiary);
  border-radius: 1px;
}

.context-mini-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
  transition: width 0.3s ease, left 0.3s ease, background 0.3s ease;
}

.context-mini-bar.cached { background: #2dd4bf; }
.context-mini-bar.warning { background: var(--color-warning); }
.context-mini-bar.danger { background: var(--color-error); }

.context-mini-tip {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  font-size: 10px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
  z-index: 10;
}

.context-mini:hover .context-mini-tip {
  opacity: 1;
  visibility: visible;
}

.uploaded-docs {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.parsing-docs {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.uploaded-docs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.uploaded-docs-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.btn-clear-docs {
  padding: 2px 4px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.6;
  transition: all 0.2s;
}

.btn-clear-docs:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.uploaded-docs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.parsing-docs-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px;
}

.parsing-doc-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  min-width: 0;
}

.parsing-doc-item.has-error {
  border-color: rgba(var(--color-error-rgb), 0.5);
  background: rgba(var(--color-error-rgb), 0.05);
}

.parsing-doc-item.completed {
  border-color: rgba(var(--color-success-rgb), 0.45);
}

.parsing-doc-main {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11px;
}

.parse-percent {
  margin-left: auto;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.parse-progress-track {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.parse-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: var(--accent-primary);
  transition: width 0.2s ease;
}

.parsing-doc-item.has-error .parse-progress-bar {
  background: var(--color-error);
}

.parsing-doc-item.completed .parse-progress-bar {
  background: var(--color-success);
}

.parse-phase {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.uploaded-doc-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 11px;
  max-width: 200px;
}

.uploaded-doc-item.has-error {
  border-color: rgba(var(--color-error-rgb), 0.5);
  background: rgba(var(--color-error-rgb), 0.05);
}

.doc-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.doc-name {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.doc-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
}

.doc-error {
  flex-shrink: 0;
  cursor: help;
  position: relative;
}

.doc-error::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(30, 30, 30, 0.95);
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  max-width: 280px;
  min-width: 120px;
  z-index: 1000;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(var(--color-error-rgb), 0.3);
}

.doc-error::before {
  content: '';
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(30, 30, 30, 0.95);
  z-index: 1001;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
}

.doc-error:hover::after,
.doc-error:hover::before {
  opacity: 1;
  visibility: visible;
}

.btn-remove-doc {
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.5;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-remove-doc:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.composer-quote-snips {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.composer-quote-snips-header {
  margin-bottom: 6px;
}

.composer-quote-snips-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.composer-quote-snips-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.composer-quote-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-primary);
}

.composer-quote-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-quote-chip-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.7;
}

.composer-quote-chip-remove:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
}

.ai-input {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-tertiary) 0%, var(--bg-primary) 100%);
}

/* embedded：空态仅保留内层 input-container；有附件时由 composer-root 统一外框 */
.composer-root:not(.composer-root-embedded) {
  display: contents;
}

.composer-root-embedded-filled {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.composer-root-embedded-filled .parsing-docs,
.composer-root-embedded-filled .uploaded-docs,
.composer-root-embedded-filled .composer-quote-snips {
  border-top: none;
  background: transparent;
  padding: 11px 11px 0;
}

/* 附件区与下方分割线之间留足间距（文档列表不要紧贴分隔线） */
.composer-root-embedded-filled .parsing-docs:has(~ .ai-input-embedded),
.composer-root-embedded-filled .uploaded-docs:has(~ .ai-input-embedded),
.composer-root-embedded-filled .composer-quote-snips:has(~ .ai-input-embedded) {
  padding-bottom: 11px;
}

.composer-root-embedded-filled .parsing-docs + .uploaded-docs,
.composer-root-embedded-filled .parsing-docs + .composer-quote-snips,
.composer-root-embedded-filled .uploaded-docs + .composer-quote-snips {
  padding-top: 8px;
}

.composer-root-embedded-filled .parsing-docs ~ .ai-input-embedded,
.composer-root-embedded-filled .uploaded-docs ~ .ai-input-embedded,
.composer-root-embedded-filled .composer-quote-snips ~ .ai-input-embedded {
  border-top: 1px solid var(--border-color);
}

.ai-input.ai-input-embedded {
  border-top: none;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.composer-root-embedded-filled .ai-input-embedded {
  padding: 11px 11px 11px;
}

.composer-root-embedded-filled .ai-input-embedded .image-preview-strip {
  padding-top: 0;
  padding-left: 0;
  padding-right: 0;
}

.ai-input-embedded textarea:focus,
.ai-input-embedded textarea:focus-visible {
  border: none;
  outline: none;
  box-shadow: none;
}

.input-container {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 10px;
  background: var(--bg-surface);
  border: none;
  border-radius: 16px;
  transition: box-shadow 0.2s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

/* 两行模式（footer-left slot 有内容时自动切换） */
.input-container-two-row {
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 10px 10px 6px;
}

.input-container-two-row textarea {
  width: 100%;
  padding: 0 4px;
  min-height: 24px;
  align-self: stretch;
  flex: none; /* let JS adjustTextareaHeight control height in column-flex */
}

.input-bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.input-footer-left {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.input-footer-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.input-container:has(textarea:focus) {
  box-shadow: 0 0 0 2px var(--accent-primary), 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* flash-hint：场景卡片填入 prompt 后的一次性脉冲，提醒用户"输入框已就绪，按 Enter 发送"。
   动画期间盖过 :has(textarea:focus) 的 box-shadow（因 specificity + 动画在同 selector 上覆盖），
   1.5s 后 class 自动移除，恢复默认 / focus 态外观。 */
.input-container.flash-hint {
  animation: composerFlashHint 1.5s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes composerFlashHint {
  0% {
    box-shadow:
      0 0 0 0 rgba(var(--accent-decorative-rgb), 0.6),
      0 0 0 0 rgba(var(--accent-decorative-rgb), 0),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  25% {
    box-shadow:
      0 0 0 4px rgba(var(--accent-decorative-rgb), 0.55),
      0 0 22px 2px rgba(var(--accent-decorative-rgb), 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  100% {
    box-shadow:
      0 0 0 2px var(--accent-primary),
      0 4px 12px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
}

.upload-btn,
.voice-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  box-sizing: border-box;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.upload-btn:hover:not(:disabled),
.voice-btn:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--accent-primary);
  transform: scale(1.08);
}

.upload-btn:active:not(:disabled),
.voice-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.upload-btn:disabled,
.voice-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.upload-spinner,
.mention-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(var(--accent-rgb), 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.voice-btn.recording {
  color: var(--color-error);
  background: rgba(255, 100, 100, 0.15);
  animation: pulse-recording 1.5s ease-in-out infinite;
}

.voice-btn.transcribing {
  color: var(--accent-primary);
}

.voice-btn .spin {
  animation: spin 1s linear infinite;
}

@keyframes pulse-recording {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 100, 100, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(255, 100, 100, 0); }
}

.ai-input textarea {
  flex: 1;
  align-self: center;
  padding: 7px 4px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  line-height: 1.4286;
  min-height: 20px;
  max-height: 360px;
  overflow-y: auto;
  margin: 0;
}

.ai-input textarea::placeholder {
  color: var(--text-muted);
  opacity: 0.7;
}

/* 焦点环由外层 .input-container:has(textarea:focus) 统一提供，
   textarea 内部不再叠加全局 textarea:focus 光晕，避免出现两层焦点。 */
.ai-input textarea:focus {
  border-color: transparent;
  box-shadow: none;
  outline: none;
}

.send-btn,
.stop-btn {
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.send-btn {
  background: linear-gradient(135deg, #6b8cff 0%, #5a7bff 50%, #4f6ef7 100%);
  box-shadow: 0 2px 8px rgba(90, 123, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.send-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.send-btn-agent {
  background: linear-gradient(135deg, var(--color-success) 0%, var(--color-success) 50%, var(--color-success) 100%);
}

.send-btn-supplement {
  background: linear-gradient(135deg, var(--color-warning) 0%, var(--color-warning) 50%, var(--color-warning) 100%);
}

.send-btn-default {
  background: linear-gradient(135deg, var(--color-success) 0%, var(--color-success) 50%, var(--color-success) 100%);
}

.stop-btn {
  background: linear-gradient(135deg, var(--color-error) 0%, var(--color-error) 50%, var(--color-error) 100%);
  box-shadow: 0 2px 8px rgba(var(--color-error-rgb), 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.stop-btn:hover {
  transform: translateY(-1px);
  background: linear-gradient(135deg, #fca5a5 0%, var(--color-error) 50%, var(--color-error) 100%);
  box-shadow: 0 4px 16px rgba(var(--color-error-rgb), 0.5);
}

.tts-stop-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  background: rgba(99, 102, 241, 0.15);
  color: var(--accent-primary, #6366f1);
  transition: all 0.2s ease;
}

.tts-stop-btn:hover {
  background: rgba(99, 102, 241, 0.3);
}

@keyframes tts-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.tts-speaking-icon {
  animation: tts-pulse 1.5s ease-in-out infinite;
}

.stop-btn:active {
  transform: translateY(0) scale(0.95);
}

.mention-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 100;
}

.mention-menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.mention-path {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 1;
  min-width: 0;
  max-width: 85%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: right;
}

.mention-loading,
.mention-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.mention-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
}

.mention-item.active {
  background: rgba(var(--accent-rgb), 0.15);
}

.mention-more {
  padding: 8px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.mention-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.mention-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-desc {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.mention-back-btn {
  cursor: pointer;
  padding: 4px 10px;
  background: var(--bg-surface);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.15s;
  flex-shrink: 0;
}

.mention-back-btn:hover {
  background: var(--accent-primary);
  color: #fff;
}

.mention-hint-keys {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mention-hint-keys span {
  padding: 2px 6px;
  background: var(--bg-surface);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}

.image-preview-strip {
  display: flex;
  gap: 8px;
  padding: 8px 12px 4px;
  overflow-x: auto;
  flex-shrink: 0;
}

.image-preview-item {
  position: relative;
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
}

.image-thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  cursor: pointer;
}

.image-remove-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.image-preview-item:hover .image-remove-btn {
  opacity: 1;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
