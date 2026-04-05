<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, Square, ArrowUp, Check, Mic, MicOff, Loader2 } from 'lucide-vue-next'
import { useMentions } from '../composables/useMentions'
import type { ParsedDocument } from '../stores/terminal'

interface ContextStats {
  tokenEstimate: number
  maxTokens: number
  percentage: number
  cacheHitRate?: number
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
  submitMessage: (message: string) => void | Promise<void>
  submitEmptyMessage: () => void | Promise<void>
  clearTabError: () => void
}>()

const { t } = useI18n()

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

watch(() => props.visible, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      focusInput()
      adjustTextareaHeight()
    })
  }
}, { immediate: true })

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
  closeMentionMenu()

  if (!inputText.value.trim() && !props.hasImages && props.canSendEmpty && props.isAgentRunning) {
    props.clearTabError()
    await props.submitEmptyMessage()
    return
  }

  if (!inputText.value.trim() && props.hasImages) {
    inputText.value = t('ai.describeImage')
  }

  if (!inputText.value.trim() && !props.hasImages) {
    return
  }

  const messageToSend = inputText.value
  inputText.value = ''
  props.clearTabError()

  await new Promise(resolve => setTimeout(resolve, 0))

  const { contextParts } = await expandMentions(messageToSend)
  const finalMessage = contextParts.length > 0
    ? `${messageToSend}\n\n${contextParts.join('\n\n')}`
    : messageToSend

  clearMentions()

  await new Promise(resolve => setTimeout(resolve, 0))
  await props.submitMessage(finalMessage)
}

const getDocIcon = (fileType: string) => {
  if (fileType === 'pdf') return '📕'
  if (fileType === 'docx' || fileType === 'doc') return '📘'
  return '📄'
}

defineExpose({
  focusInput,
  appendText,
  setText,
  clearText,
  getText: () => inputText.value
})

const handleSendClick = (event: MouseEvent) => {
  event.preventDefault()
  void handleSend()
}
</script>

<template>
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

  <div class="ai-input">
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
        {{ t('ai.context') }}: {{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K ({{ contextStats.percentage }}%)<template v-if="contextStats.cacheHitRate !== undefined"> · Cache {{ contextStats.cacheHitRate }}%</template>
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

    <div class="input-container">
      <button
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
        :placeholder="isAgentRunning ? t('ai.inputPlaceholderSupplement') : t('ai.inputPlaceholderAgent')"
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
        v-if="isLoading && !isAgentRunning"
        class="stop-btn"
        @click="stopGeneration"
        :title="t('ai.stopGeneration')"
      >
        <Square :size="16" fill="currentColor" />
      </button>
      <button
        v-else-if="isAgentRunning && inputText.trim()"
        class="send-btn send-btn-supplement"
        :title="t('ai.sendSupplement')"
        @click="handleSendClick"
      >
        <ArrowUp :size="18" />
      </button>
      <button
        v-else-if="isAgentRunning && canSendEmpty"
        class="send-btn send-btn-default"
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
        :disabled="!inputText.trim() && !hasImages"
        :title="t('ai.executeTask')"
        @click="handleSendClick"
      >
        <ArrowUp :size="18" />
      </button>
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
.context-mini-bar.warning { background: var(--accent-warning, #f59e0b); }
.context-mini-bar.danger { background: var(--accent-error, #ef4444); }

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
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.uploaded-docs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.05);
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
  border: 1px solid rgba(239, 68, 68, 0.3);
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
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
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

.input-container:focus-within {
  box-shadow: 0 0 0 2px var(--accent-primary), 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.upload-btn,
.voice-btn {
  flex-shrink: 0;
  padding: 6px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.upload-btn:hover:not(:disabled),
.voice-btn:hover:not(:disabled) {
  background: rgba(100, 150, 255, 0.12);
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
  border: 2px solid rgba(100, 150, 255, 0.2);
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
  padding: 6px 4px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 24px;
  max-height: 360px;
  overflow-y: auto;
}

.ai-input textarea::placeholder {
  color: var(--text-muted);
  opacity: 0.7;
}

.send-btn,
.stop-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 10px;
  border: none;
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
  background: linear-gradient(135deg, #34d399 0%, #10b981 50%, #059669 100%);
}

.send-btn-supplement {
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%);
}

.send-btn-default {
  background: linear-gradient(135deg, #6ee7b7 0%, #10b981 50%, #059669 100%);
}

.stop-btn {
  background: linear-gradient(135deg, #f87171 0%, #ef4444 50%, #dc2626 100%);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
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
  background: rgba(100, 150, 255, 0.15);
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
