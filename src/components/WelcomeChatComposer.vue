<script setup lang="ts">
/**
 * 欢迎页 AI 快速发起入口 —— 复用 AiComposer（附件、语音、@ 提及等）
 * 发送后创建独立助手 tab，并将文档/图片 handoff 给 AiPanel 自动 runAgent。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AiComposer from './AiComposer.vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { useDocumentUpload } from '../composables/useDocumentUpload'
import { useImageUpload } from '../composables/useImageUpload'
import { useSpeechRecognition } from '../composables/useSpeechRecognition'
import { planComposerPaste, ingestComposerAttachments } from '../composables/useComposerPaste'
import { showConfirm } from '../composables/useConfirm'
import { toast } from '../composables/useToast'

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

const composerTabId = ref(WELCOME_COMPOSER_TAB_ID)
const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)
const isMounted = ref(false)
const previewImageUrl = ref<string | null>(null)

const {
  uploadedDocs,
  parsingDocs,
  isUploadingDocs,
  removeUploadedDoc,
  clearUploadedDocs,
  formatFileSize,
  handleDroppedFiles
} = useDocumentUpload(composerTabId)

const {
  pendingImages,
  isProcessingImage,
  handleDroppedImages,
  removeImage,
  clearImages,
  hasImages
} = useImageUpload()

const isAttaching = computed(() => isUploadingDocs.value || isProcessingImage.value)
const hasImagesComputed = computed(() => hasImages())
const hasComposerAttachments = computed(
  () =>
    uploadedDocs.value.length > 0 ||
    parsingDocs.value.length > 0 ||
    pendingImages.value.length > 0
)

const ingestAttachmentFiles = (files: FileList | File[]) =>
  ingestComposerAttachments(files, {
    ingestImages: handleDroppedImages,
    ingestDocuments: handleDroppedFiles
  })

const selectAttachment = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = ''
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return
    await ingestAttachmentFiles(input.files)
  }
  input.click()
}

const handlePaste = async (event: ClipboardEvent) => {
  const plan = planComposerPaste(event)
  if (plan.kind === 'default') return
  event.preventDefault()
  await ingestAttachmentFiles(plan.files)
}

const {
  isRecording,
  isTranscribing,
  isInitializing: isSpeechInitializing,
  audioAvailable,
  error: speechError,
  startRecording,
  stopRecording,
  cancelRecording
} = useSpeechRecognition()

watch(speechError, (error) => {
  if (error) toast.error(t('ai.speechError', { error }))
})

const handleRecordClick = async () => {
  if (isRecording.value) {
    const result = await stopRecording()
    if (result?.text) composerRef.value?.appendText(result.text)
  } else {
    await startRecording()
  }
}

// Push-to-Talk（欢迎页无 active tab，独立监听）
const isPushToTalk = ref(false)
let pttStopTimer: ReturnType<typeof setTimeout> | null = null
let pttStartTimer: ReturnType<typeof setTimeout> | null = null
const PTT_HOLD_THRESHOLD = 300

const clearPTTStopTimer = () => {
  if (pttStopTimer) {
    clearTimeout(pttStopTimer)
    pttStopTimer = null
  }
}

const clearPTTStartTimer = () => {
  if (pttStartTimer) {
    clearTimeout(pttStartTimer)
    pttStartTimer = null
  }
}

const MODIFIER_EVENT_PROPS: Record<string, keyof KeyboardEvent> = {
  Control: 'ctrlKey',
  Meta: 'metaKey',
  Shift: 'shiftKey',
  Alt: 'altKey'
}

function hasOtherModifiers(event: KeyboardEvent, pttKey: string): boolean {
  for (const [key, prop] of Object.entries(MODIFIER_EVENT_PROPS)) {
    if (key !== pttKey && event[prop as keyof KeyboardEvent]) return true
  }
  return false
}

const handlePTTKeyDown = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (!pttKey || !audioAvailable.value || !isMounted.value) return

  if (event.key !== pttKey) {
    if (isPushToTalk.value || pttStartTimer || isRecording.value) {
      clearPTTStartTimer()
      clearPTTStopTimer()
      isPushToTalk.value = false
      cancelRecording()
    }
    return
  }

  if (event.repeat) return
  if (hasOtherModifiers(event, pttKey)) return
  if (pttStopTimer) {
    clearPTTStopTimer()
    return
  }
  if (pttStartTimer) return
  if (isRecording.value || isTranscribing.value || isSpeechInitializing.value) return

  isPushToTalk.value = true
  pttStartTimer = setTimeout(() => {
    pttStartTimer = null
    if (isPushToTalk.value) startRecording()
  }, PTT_HOLD_THRESHOLD)
}

const finishPTTRecording = async () => {
  pttStopTimer = null
  isPushToTalk.value = false
  const result = await stopRecording()
  if (!isMounted.value) return
  if (result?.text) composerRef.value?.appendText(result.text)
}

const handlePTTKeyUp = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (event.key !== pttKey || !isPushToTalk.value) return

  if (pttStartTimer) {
    clearPTTStartTimer()
    isPushToTalk.value = false
    return
  }

  clearPTTStopTimer()
  pttStopTimer = setTimeout(finishPTTRecording, 200)
}

const handlePTTWindowBlur = () => {
  if (isPushToTalk.value || pttStartTimer) {
    clearPTTStartTimer()
    clearPTTStopTimer()
    isPushToTalk.value = false
    cancelRecording()
  }
}

const activeAiProfile = computed(() =>
  configStore.aiProfiles.find(p => p.id === configStore.activeAiProfileId) || null
)

let visionWarningShown = false
const checkVisionSupport = async () => {
  if (visionWarningShown) return
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (!hasVision) {
    visionWarningShown = true
    toast.warning(t('ai.visionNotSupported', { model: activeAiProfile.value?.model || '' }), 6000)
  }
}

watch(() => pendingImages.value.length, (newLen, oldLen) => {
  if (newLen > oldLen) void checkVisionSupport()
})

const guardVisionBeforeSend = async (): Promise<boolean> => {
  if (!hasImages()) return true
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (hasVision) return true

  const proceed = await showConfirm({
    type: 'warning',
    title: t('ai.visionGuardTitle'),
    message: t('ai.visionGuardMessage', { model: activeAiProfile.value?.model || t('ai.visionGuardCurrentModel') }),
    detail: t('ai.visionGuardDetail'),
    confirmText: t('ai.visionGuardSendAnyway'),
    cancelText: t('common.cancel'),
    neutralText: t('ai.visionGuardOpenSettings'),
    onNeutral: () => showSettings?.()
  })
  if (proceed) {
    clearImages()
    toast.info(t('ai.visionGuardImagesDropped'))
  }
  return proceed
}

const contextStats = computed(() => ({
  tokenEstimate: 0,
  maxTokens: 100_000,
  percentage: 0
}))

const openImagePreview = (url: string) => {
  previewImageUrl.value = url
}

const closeImagePreview = () => {
  previewImageUrl.value = null
}

const noop = () => {}

const handleComposerSubmit = async (message: string) => {
  if (!(await guardVisionBeforeSend())) return

  const imagesSnapshot = pendingImages.value.map(img => ({ ...img }))
  const tabId = terminalStore.createAssistantTab()
  terminalStore.transferUploadedDocs(WELCOME_COMPOSER_TAB_ID, tabId)
  terminalStore.setPendingComposerHandoff(tabId, { message, images: imagesSnapshot })
  terminalStore.markAssistantSkipOnboarding(tabId)
  clearImages()
}

onMounted(() => {
  isMounted.value = true
  document.addEventListener('keydown', handlePTTKeyDown, true)
  document.addEventListener('keyup', handlePTTKeyUp, true)
  window.addEventListener('blur', handlePTTWindowBlur)
  nextTick(() => composerRef.value?.focusInput())
})

onUnmounted(() => {
  isMounted.value = false
  document.removeEventListener('keydown', handlePTTKeyDown, true)
  document.removeEventListener('keyup', handlePTTKeyUp, true)
  window.removeEventListener('blur', handlePTTWindowBlur)
  clearPTTStartTimer()
  clearPTTStopTimer()
  cancelRecording()
})
</script>

<template>
  <div class="welcome-chat-composer" :class="{ 'has-attachments': hasComposerAttachments }">
    <AiComposer
      ref="composerRef"
      embedded
      :placeholder="t('welcome.chatLead')"
      :current-tab-id="composerTabId"
      :visible="true"
      :context-stats="contextStats"
      :cache-bar-width="0"
      :uploaded-docs="uploadedDocs"
      :parsing-docs="parsingDocs"
      :pending-images="pendingImages"
      :is-attaching="isAttaching"
      :is-agent-running="false"
      :is-loading="false"
      :can-send-empty="false"
      :has-images="hasImagesComputed"
      :is-recording="isRecording"
      :is-transcribing="isTranscribing"
      :is-push-to-talk="isPushToTalk"
      :audio-available="audioAvailable"
      :is-speech-initializing="isSpeechInitializing"
      :format-file-size="(size?: number) => formatFileSize(size ?? 0)"
      :open-image-preview="openImagePreview"
      :remove-image="removeImage"
      :select-attachment="selectAttachment"
      :remove-uploaded-doc="removeUploadedDoc"
      :clear-uploaded-docs="clearUploadedDocs"
      :handle-paste="handlePaste"
      :handle-record-click="handleRecordClick"
      :stop-generation="noop"
      :abort-agent="noop"
      :tts-is-speaking="false"
      :tts-stop="noop"
      :submit-message="handleComposerSubmit"
      :submit-empty-message="noop"
      :clear-tab-error="noop"
    />

    <div v-if="previewImageUrl" class="welcome-image-preview" @click.self="closeImagePreview">
      <button type="button" class="welcome-image-preview-close" @click="closeImagePreview">×</button>
      <img :src="previewImageUrl" alt="" class="welcome-image-preview-img" />
    </div>
  </div>
</template>

<style scoped>
.welcome-chat-composer {
  margin-bottom: 28px;
  animation: welcomeComposerEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.06s forwards;
  opacity: 0;
}

@keyframes welcomeComposerEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.welcome-image-preview {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.75);
}

.welcome-image-preview-close {
  position: absolute;
  top: 16px;
  right: 20px;
  border: none;
  background: transparent;
  color: white;
  font-size: 28px;
  cursor: pointer;
  line-height: 1;
}

.welcome-image-preview-img {
  max-width: min(90vw, 960px);
  max-height: 85vh;
  object-fit: contain;
  border-radius: 8px;
}
</style>
