<script setup lang="ts">
/**
 * 欢迎页 AI 快速发起入口 —— 复用 AiComposer（附件、语音、@ 提及等）
 * 发送后创建独立助手 tab，并将文档/图片 handoff 给 AiPanel 自动 runAgent。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AiComposer from './AiComposer.vue'
import AiProfileSelect from './AiProfileSelect.vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { useDocumentUpload } from '../composables/useDocumentUpload'
import { useImageUpload } from '../composables/useImageUpload'
import { useSpeechRecognition, SPEECH_PACK_NOT_INSTALLED } from '../composables/useSpeechRecognition'
import { planComposerPaste, ingestComposerAttachments } from '../composables/useComposerPaste'
import { showConfirm } from '../composables/useConfirm'
import { toast } from '../composables/useToast'

const props = defineProps<{
  /** 欢迎页是否为当前主界面（切到 tab 时为 false，用于禁用全局 PTT 监听） */
  active?: boolean
}>()

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')
const openAppSettings = inject<(tab?: string, section?: string) => void>('openAppSettings')

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
  loadPendingImages,
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

const focusComposer = () => {
  composerRef.value?.focusInput()
}

defineExpose({ ingestAttachmentFiles, focusComposer })

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
  if (!error) return
  if (error === SPEECH_PACK_NOT_INSTALLED) {
    toast.show(t('ai.speechPackNotInstalled'), 'warning', 6000, true, {
      action: t('ai.speechPackOpenSettings'),
      onClick: () => openAppSettings?.('ai', 'speechPack'),
    })
    return
  }
  toast.error(t('ai.speechError', { error }))
})

watch(() => props.active, (active) => {
  if (active) return
  if (!isPushToTalk.value && !pttStartTimer && !isRecording.value) return
  clearPTTStartTimer()
  clearPTTStopTimer()
  isPushToTalk.value = false
  cancelRecording()
})

const handleRecordClick = async () => {
  if (!props.active) return
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
  if (!pttKey || !audioAvailable.value || !isMounted.value || !props.active) return

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
  if (!props.active || event.key !== pttKey || !isPushToTalk.value) return

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

const handlePreviewKeyDown = (event: KeyboardEvent) => {
  if (!previewImageUrl.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  closeImagePreview()
}

watch(previewImageUrl, (url) => {
  if (url) {
    document.addEventListener('keydown', handlePreviewKeyDown, true)
  } else {
    document.removeEventListener('keydown', handlePreviewKeyDown, true)
  }
})

/** 发送成功后跳过 onUnmounted 草稿回写（避免与 clearWelcomeComposerDraft 竞态） */
let skipDraftPersist = false

const persistWelcomeComposerDraft = () => {
  terminalStore.setWelcomeComposerDraft(
    composerRef.value?.getText() ?? '',
    pendingImages.value.map(img => ({ ...img }))
  )
}

const restoreWelcomeComposerDraft = () => {
  const draft = terminalStore.getWelcomeComposerDraft()
  loadPendingImages(draft.images)
  nextTick(() => {
    if (draft.text) composerRef.value?.setText(draft.text)
    composerRef.value?.focusInput()
  })
}

const noop = () => {}

const handleComposerSubmit = async (message: string) => {
  if (!(await guardVisionBeforeSend())) return

  const imagesSnapshot = pendingImages.value.map(img => ({ ...img }))
  skipDraftPersist = true
  clearImages()
  terminalStore.clearWelcomeComposerDraft()
  const tabId = terminalStore.createAssistantTab({ activate: false })
  terminalStore.transferUploadedDocs(WELCOME_COMPOSER_TAB_ID, tabId)
  terminalStore.setPendingComposerHandoff(tabId, { message, images: imagesSnapshot })
  terminalStore.markAssistantSkipOnboarding(tabId)
  terminalStore.focusHubConversation(tabId)
  // 任务已切入 Hub 后，关闭首页「初次见面」邀请
  void configStore.markAgentOnboardingShown()
}

onMounted(() => {
  isMounted.value = true
  skipDraftPersist = false
  restoreWelcomeComposerDraft()
  document.addEventListener('keydown', handlePTTKeyDown, true)
  document.addEventListener('keyup', handlePTTKeyUp, true)
  window.addEventListener('blur', handlePTTWindowBlur)
  // 初始可见时自动聚焦
  if (props.active) {
    nextTick(() => composerRef.value?.focusInput())
  }
})

// 每次切回欢迎页（active 变为 true）时聚焦输入框
watch(() => props.active, (active) => {
  if (active) {
    nextTick(() => {
      composerRef.value?.focusInput()
      composerRef.value?.refreshPlaceholder?.()
    })
  }
})

onUnmounted(() => {
  isMounted.value = false
  if (!skipDraftPersist) persistWelcomeComposerDraft()
  document.removeEventListener('keydown', handlePreviewKeyDown, true)
  document.removeEventListener('keydown', handlePTTKeyDown, true)
  document.removeEventListener('keyup', handlePTTKeyUp, true)
  window.removeEventListener('blur', handlePTTWindowBlur)
  clearPTTStartTimer()
  clearPTTStopTimer()
  cancelRecording()
})
</script>

<template>
  <div
    class="welcome-chat-composer"
    :class="{ 'has-attachments': hasComposerAttachments }"
  >
    <AiComposer
      ref="composerRef"
      embedded
      placeholder-pools-key="welcome.chatLeadPools"
      placeholder-fallback-key="welcome.chatLead"
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
      :voice-input-enabled="!!configStore.keyboardShortcuts.voiceInput"
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
    >
      <template #footer-left>
        <AiProfileSelect
          v-if="configStore.aiProfiles.length > 0"
          embedded
          :profiles="configStore.aiProfiles"
          :model-value="configStore.activeAiProfileId"
          @update:model-value="configStore.setActiveAiProfile"
        />
      </template>
    </AiComposer>
    <!-- Teleport 到 body：父级 welcome-chat-composer 的 transform 动画会创建层叠上下文，
         导致 position:fixed 预览被限制在 composer 区域内，无法盖住下方快速启动卡片 -->
    <Teleport to="body">
      <div v-if="previewImageUrl" class="welcome-image-preview" @click.self="closeImagePreview">
        <button type="button" class="welcome-image-preview-close" @click="closeImagePreview">×</button>
        <img :src="previewImageUrl" alt="" class="welcome-image-preview-img" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.welcome-chat-composer {
  margin-bottom: 18px;
  animation: welcomeComposerEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.06s forwards;
  opacity: 0;
}

/* 欢迎页 textarea 最大高度比面板模式矮，避免把 logo 和卡片都撑出屏幕 */
.welcome-chat-composer :deep(.ai-input textarea) {
  max-height: 160px;
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
