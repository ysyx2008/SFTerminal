<script setup lang="ts">
/**
 * AI 面板组件
 * 重构版本：使用 composables 模块化管理逻辑
 * 每个 tab 独立实例，通过 tabId prop 绑定
 */
import { ref, reactive, computed, watch, inject, onMounted, onUnmounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, Trash2, X, HelpCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-vue-next'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import AgentPlanView from './AgentPlanView.vue'
import AiComposer from './AiComposer.vue'
import sailfishLogo from '../../resources/logo.png'

// 导入 composables
import {
  useMarkdown,
  useDocumentUpload,
  useImageUpload,
  useContextStats,
  useHostProfile,
  useAgentMode,
  useSpeechRecognition,
  toast
} from '../composables'

// Props - 每个 AiPanel 实例绑定到特定的 tab
const props = defineProps<{
  tabId: string
  visible?: boolean  // 面板是否可见
}>()

// Emits
const emit = defineEmits<{
  close: []
}>()

// i18n
const { t } = useI18n()

// Stores
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

const isStandaloneAssistant = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  return tab?.type === 'assistant'
})

const handleClose = () => {
  if (isStandaloneAssistant.value) {
    terminalStore.closeTab(props.tabId)
  } else if (terminalStore.tabs.some(t => t.id === props.tabId)) {
    emit('close')
  }
}

// Refs
const messagesRef = ref<HTMLDivElement | null>(null)
const scrollerRef = ref<InstanceType<typeof DynamicScroller> | null>(null)
const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)

// 统一附件选择（图片 + 文档，自动按类型分流）
const isAttaching = computed(() => isUploadingDocs.value || isProcessingImage.value)
const selectAttachment = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  // 同时接受图片和文档
  input.accept = ''
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return
    const imageFiles: File[] = []
    const docFiles: File[] = []
    for (const file of input.files) {
      if (file.type.startsWith('image/')) {
        imageFiles.push(file)
      } else {
        docFiles.push(file)
      }
    }
    // 图片走 useImageUpload
    if (imageFiles.length > 0) {
      await handleDroppedImages(imageFiles)
    }
    // 文档走 useDocumentUpload
    if (docFiles.length > 0) {
      await handleDroppedFiles(docFiles)
    }
  }
  input.click()
}

// Plan 展开状态
const planExpanded = ref(false)

// 步骤中的计划展开状态（用于查看归档的计划）
const expandedPlanSteps = ref<Set<string>>(new Set())
const togglePlanExpand = (stepId: string) => {
  if (expandedPlanSteps.value.has(stepId)) {
    expandedPlanSteps.value.delete(stepId)
  } else {
    expandedPlanSteps.value.add(stepId)
  }
}

// 子 Agent 展开状态（默认收起，用户点击切换）
const subAgentExpandState = reactive(new Map<string, boolean>())
const isSubAgentExpanded = (key: string): boolean => {
  return subAgentExpandState.get(key) === true
}
const toggleSubAgentExpand = (key: string) => {
  subAgentExpandState.set(key, !isSubAgentExpanded(key))
}

/** 获取子 Agent 当前活动摘要（最新的 running 或最后一个已完成步骤的 tool+args） */
const getSubAgentActivity = (sa: import('@shared/types').SubAgentResult): string | null => {
  if (!sa.steps || sa.steps.length === 0) return null
  const running = [...sa.steps].reverse().find(s => s.status === 'running')
  const step = running || sa.steps[sa.steps.length - 1]
  const parts = [step.tool]
  if (step.args) parts.push(step.args)
  return parts.join(' ')
}


// ==================== 初始化 Composables ====================

// 当前终端 ID（使用 prop，每个实例固定绑定一个 tab）
const currentTabId = toRef(props, 'tabId')

// 文档上传（传入 currentTabId，每个终端独立管理文档）
const {
  uploadedDocs,
  isUploadingDocs,
  isDraggingOver,
  handleDroppedFiles,
  removeUploadedDoc,
  clearUploadedDocs,
  formatFileSize,
  getDocumentContext,
  getDocPreviewImages,
  getAllDocImages,
  getDocImagesContext
} = useDocumentUpload(currentTabId)

// 图片上传（视觉理解）
const {
  pendingImages,
  isProcessingImage,
  handlePasteImages,
  handleDroppedImages,
  removeImage,
  clearImages,
  getImageDataUrls,
  hasImages
} = useImageUpload()

const hasImagesComputed = computed(() => hasImages())

// Markdown 渲染
const {
  renderMarkdown,
  handleCodeBlockClick,
  handleFilePathContextMenu
} = useMarkdown()

// 主机档案
const {
  currentHostProfile,
  isLoadingProfile,
  isProbing,
  getHostIdByTabId,
  loadHostProfile,
  refreshHostProfile,
  autoProbeHostProfile
} = useHostProfile()

// Agent 模式（包含输入、滚动、终端状态等所有功能）
const {
  isLoading,
  currentSystemInfo,
  terminalSelectedText,
  lastError,
  // 滚动相关
  hasNewMessage,
  updateScrollPosition,
  scrollToBottom,
  stopGeneration,
  // Agent 执行
  executionMode,
  commandTimeout,
  activeProfileId,
  agentState,
  isAgentRunning,
  pendingConfirm,
  agentUserTask,
  currentPlan,
  agentTaskGroups,
  flattenedItems,
  runAgent,
  abortAgent,
  confirmToolCall,
  sendAgentReply,
  getStepIcon,
  getRiskClass,
  // 历史对话功能
  recentHistory,
  isLoadingHistory,
  showHistoryModal,
  allHistory,
  isLoadingAllHistory,
  hasMoreHistory,
  loadMoreHistory,
  openHistoryModal,
  closeHistoryModal,
  loadHistoryRecord,
  hasExistingConversation,
  formatHistoryTime,
  saveCurrentSession,
  getAgentKey,
  ttsIsSpeaking,
  ttsStop,
} = useAgentMode(
  messagesRef,
  async () => {
    const textContext = await getDocumentContext()
    const scannedContext = getDocImagesContext()
    return [textContext, scannedContext].filter(Boolean).join('\n\n')
  },
  getHostIdByTabId,
  autoProbeHostProfile,
  currentTabId,
  {
    getImages: () => [...getImageDataUrls(), ...getAllDocImages()],
    getPreviewImages: () => [...getImageDataUrls(), ...getDocPreviewImages()],
    clearImages
  },
  {
    getAttachments: () => uploadedDocs.value
      .map(d => ({
        filename: d.filename,
        filePath: d.filePath,
        fileSize: d.fileSize,
        fileType: d.fileType,
        totalPages: d.totalPages || d.pageCount,
        previewPages: d.images?.length
      })),
    clearAttachments: clearUploadedDocs
  }
)

// 语音识别
const {
  isRecording,
  isTranscribing,
  isInitializing: isSpeechInitializing,
  audioAvailable,
  error: speechError,
  checkAndInitialize: initSpeech,
  startRecording,
  stopRecording,
  cancelRecording
} = useSpeechRecognition()

// 监听语音识别错误并显示提示
watch(speechError, (error) => {
  if (error) {
    toast.error(t('ai.speechError', { error }))
  }
})

// 处理录音按钮点击
const handleRecordClick = async () => {
  if (isRecording.value) {
    // 停止录音并转录
    const result = await stopRecording()
    if (result?.text) {
      composerRef.value?.appendText(result.text)
    }
  } else {
    // 开始录音
    await startRecording()
  }
}

// Push-to-Talk：按住配置的按键说话，松开后延迟停止录音（避免末尾语音丢失）
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

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt'])
const MODIFIER_EVENT_PROPS: Record<string, keyof KeyboardEvent> = {
  Control: 'ctrlKey',
  Meta: 'metaKey',
  Shift: 'shiftKey',
  Alt: 'altKey',
}

function hasOtherModifiers(event: KeyboardEvent, pttKey: string): boolean {
  for (const [key, prop] of Object.entries(MODIFIER_EVENT_PROPS)) {
    if (key !== pttKey && event[prop as keyof KeyboardEvent]) return true
  }
  return false
}

const handlePTTKeyDown = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (!pttKey || !audioAvailable.value || !props.visible || terminalStore.activeTabId !== currentTabId.value) return

  if (event.key !== pttKey) {
    if (isPushToTalk.value || pttStartTimer) {
      clearPTTStartTimer()
      clearPTTStopTimer()
      isPushToTalk.value = false
      cancelRecording()
    }
    return
  }
  if (event.repeat) return
  if (MODIFIER_KEYS.has(pttKey) && hasOtherModifiers(event, pttKey)) return
  if (pttStopTimer) {
    clearPTTStopTimer()
    return
  }
  if (pttStartTimer) return
  if (isRecording.value || isTranscribing.value || isSpeechInitializing.value) return

  isPushToTalk.value = true
  pttStartTimer = setTimeout(() => {
    pttStartTimer = null
    if (isPushToTalk.value) {
      startRecording()
    }
  }, PTT_HOLD_THRESHOLD)
}

const finishPTTRecording = async () => {
  pttStopTimer = null
  isPushToTalk.value = false
  const result = await stopRecording()
  if (!isMounted.value) return
  if (result?.text) {
    composerRef.value?.appendText(result.text)
  }
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

// 上下文统计（使用 per-tab 的 activeAiProfile）
const {
  contextStats
} = useContextStats(
  agentState,
  agentUserTask,
  computed(() => activeAiProfile.value)
)

const cacheBarWidth = computed(() => {
  const { percentage, cacheHitRate } = contextStats.value
  if (cacheHitRate === undefined || cacheHitRate <= 0) return 0
  return Math.round(cacheHitRate / 100 * percentage * 100) / 100
})

// ==================== 配置相关 ====================

const hasAiConfig = computed(() => configStore.hasAiConfig)
const aiProfiles = computed(() => configStore.aiProfiles)

// 当前终端的 AI 配置档案（基于 per-tab activeProfileId）
const activeAiProfile = computed(() =>
  aiProfiles.value.find(p => p.id === activeProfileId.value) || null
)

// 切换 AI 配置（只影响当前终端）
const changeAiProfile = (profileId: string) => {
  activeProfileId.value = profileId
}

// ==================== 历史对话相关 ====================

// 截断文本
const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 加载历史记录（带确认）
const handleLoadHistory = (record: { id: string; timestamp: number; terminalId: string; terminalType: 'local' | 'ssh'; sshHost?: string; userTask: string; steps: Array<{ id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string; timestamp: number }>; finalResult?: string; duration: number; status: 'completed' | 'failed' | 'aborted' }) => {
  // 如果当前有活跃的任务（用户任务不为空），需要确认
  // 注意：如果欢迎页显示（agentUserTask 为空），说明没有活跃任务，不需要确认
  if (agentUserTask.value && hasExistingConversation.value) {
    if (!window.confirm(t('ai.agentWelcome.confirmLoadHistory'))) {
      return
    }
  }
  loadHistoryRecord(record)
  // 滚动到底部查看加载的历史
  scrollToBottom()
}

// ==================== 消息清空 ====================

// 清空对话确认框状态
const showClearConfirm = ref(false)

// 请求清空对话（如果 Agent 正在执行，需要用户确认）
const requestClearMessages = async () => {
  if (isAgentRunning.value) {
    // Agent 正在执行，需要确认
    showClearConfirm.value = true
  } else {
    // Agent 未运行，直接清空
    await doClearMessages()
  }
}

// 确认清空对话（先停止 Agent，再清空）
const confirmClearMessages = async () => {
  showClearConfirm.value = false
  
  // 如果 Agent 正在执行，先停止它
  if (isAgentRunning.value) {
    await abortAgent()
  }
  
  // 然后清空对话
  await doClearMessages()
}

// 取消清空对话
const cancelClearMessages = () => {
  showClearConfirm.value = false
}

// 执行清空对话（包括 Agent 状态和历史）
const doClearMessages = async () => {
  if (currentTabId.value) {
    // 在清空之前，保存当前会话到历史记录（会话级保存）
    saveCurrentSession()
    terminalStore.clearAiMessages(currentTabId.value)
    terminalStore.clearAgentState(currentTabId.value, false)  // 不保留历史
    
    // 清空后端的任务历史记忆
    const key = getAgentKey()
    if (key) {
      try {
        await window.electronAPI.agent.clearHistory(key)
      } catch (e) {
        console.warn('[AiPanel] Failed to clear agent history:', e)
      }
    }
  }
  // 清空上传的文档
  clearUploadedDocs()
}

// 兼容旧的 clearMessages（现在改为 requestClearMessages）
const clearMessages = requestClearMessages

// ==================== 确认框辅助函数 ====================

// 工具名称映射
const getToolDisplayName = (toolName: string) => {
  const key = `ai.toolNames.${toolName}`
  const translated = t(key)
  return translated !== key ? translated : toolName
}

// 格式化确认参数显示（简化显示）
const formatConfirmArgs = (confirm: typeof pendingConfirm.value) => {
  if (!confirm) return ''
  const args = confirm.toolArgs
  // 对于命令执行，只显示命令本身
  if (args.command) {
    return args.command as string
  }
  // 对于文件操作，显示路径
  if (args.path) {
    return args.path as string
  }
  // 其他情况显示 JSON
  return JSON.stringify(args, null, 2)
}


// 自由模式二次确认弹窗状态
const showFreeModeConfirm = ref(false)

// 请求启用自由模式（显示是否确认弹窗）
const requestFreeMode = () => {
  showFreeModeConfirm.value = true
}

// 确认启用自由模式
const confirmEnableFreeMode = () => {
  executionMode.value = 'free'
  showFreeModeConfirm.value = false
}

// 取消启用自由模式
const cancelFreeMode = () => {
  showFreeModeConfirm.value = false
}

// 切换到严格模式
const switchToStrictMode = () => {
  executionMode.value = 'strict'
}

// 切换到宽松模式
const switchToRelaxedMode = () => {
  executionMode.value = 'relaxed'
}

// 点击中的选项（用于即时视觉反馈，单选时使用）
const clickingOption = ref<string | null>(null)

// 多选已选中的选项（stepId -> 已选选项数组）
const multiSelectOptions = ref<Map<string, string[]>>(new Map())

// 获取步骤的已选选项
const getSelectedOptions = (stepId: string): string[] => {
  return multiSelectOptions.value.get(stepId) || []
}

// 切换多选选项
const toggleMultiOption = (stepId: string, opt: string) => {
  const current = multiSelectOptions.value.get(stepId) || []
  const idx = current.indexOf(opt)
  if (idx === -1) {
    current.push(opt)
  } else {
    current.splice(idx, 1)
  }
  multiSelectOptions.value.set(stepId, [...current])
}

// 确认多选结果
const confirmMultiSelect = (stepId: string) => {
  const selected = multiSelectOptions.value.get(stepId) || []
  if (selected.length === 0) return
  // 发送 JSON 数组格式
  sendAgentReply(JSON.stringify(selected))
  // 清理本地状态
  multiSelectOptions.value.delete(stepId)
}

// 处理选项点击（添加即时视觉反馈）
const handleOptionClick = (stepId: string, opt: string, allowMultiple: boolean) => {
  if (allowMultiple) {
    // 多选：切换选中状态
    toggleMultiOption(stepId, opt)
  } else {
    // 单选：直接发送
    clickingOption.value = opt
    sendAgentReply(opt)
  }
}

// 检查是否有等待回复的 asking 步骤（用于判断是否可以按回车发送默认值）
const waitingAskStep = computed(() => {
  for (const group of agentTaskGroups.value) {
    if (group.isCurrentTask) {
      for (const step of group.steps) {
        if (step.type === 'asking' && step.toolResult?.includes('⏳')) {
          return step
        }
      }
    }
  }
  return null
})

// 是否可以发送空消息（有等待的提问且有默认值或选项）
const canSendEmpty = computed(() => {
  const step = waitingAskStep.value
  if (!step) return false
  return !!step.toolArgs?.default_value
})

let visionWarningShown = false
const checkVisionSupport = async () => {
  if (visionWarningShown) return
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (!hasVision) {
    visionWarningShown = true
    const profile = activeAiProfile.value
    toast.warning(t('ai.visionNotSupported', { model: profile?.model || '' }), 6000)
  }
}

// 监听图片列表变化，有新图片时检测视觉支持
watch(() => pendingImages.value.length, (newLen, oldLen) => {
  if (newLen > oldLen) {
    checkVisionSupport()
  }
})

// 处理粘贴事件（检测图片）
const handlePaste = async (event: ClipboardEvent) => {
  const handled = await handlePasteImages(event)
  if (handled) {
    event.preventDefault()  // 阻止默认粘贴行为（避免粘贴图片文件名等）
  }
}

const clearTabError = () => {
  if (currentTabId.value) {
    terminalStore.clearError(currentTabId.value)
  }
}

const handleComposerSubmit = async (message: string) => {
  await runAgent(message)
}

const handleComposerEmptySubmit = async () => {
  const agentKey = getAgentKey()
  if (!agentKey || !isAgentRunning.value || !canSendEmpty.value) return
  await window.electronAPI.agent.addMessage(agentKey, '')
}

const clearComposerDraft = () => {
  composerRef.value?.clearText()
}

// ==================== 对外暴露的方法 ====================

function analyzeText(text: string) {
  clearComposerDraft()
  void runAgent(`${t('ai.analyzeContentPrompt')}\n\`\`\`\n${text}\n\`\`\``)
}

defineExpose({ analyzeText })

// ==================== 定时任务 / 远程任务监听 ====================
// 监听定时任务 / 远程任务：当有 pendingSchedulerTask 时自动执行
// 触发时机：tab 切换到当前实例、或新的 pending task 被写入当前 tab
// 需要等待终端就绪（ptyId 已分配），否则 runAgent 会因 context.ptyId 为空而静默退出
const isMounted = ref(false)
watch(
  [
    () => terminalStore.activeTabId,
    () => terminalStore.pendingSchedulerTasks[currentTabId.value],
    isMounted,
    () => terminalStore.tabs.find(t => t.id === currentTabId.value)?.ptyId,
  ],
  ([_tabId, pendingTask, mounted, _ptyId]) => {
    if (!mounted || !pendingTask) return
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    if (!tab?.ptyId && tab?.type !== 'assistant') return
    const task = terminalStore.consumePendingSchedulerTask(currentTabId.value)
    if (task) {
      console.log(`[AiPanel] 检测到待执行任务，自动执行: ${task.substring(0, 50)}...`)
      const latestProfileId = configStore.activeAiProfileId
      if (latestProfileId) {
        activeProfileId.value = latestProfileId
      }
      clearComposerDraft()
      void runAgent(task)
    }
  },
  { immediate: true }
)

// 诞生引导：首次使用时 Agent 自动发起对话
let onboardingTriggered = false
watch(
  [isMounted, () => configStore.agentOnboardingCompleted],
  async ([mounted, completed]) => {
    if (!mounted || completed || onboardingTriggered) return
    onboardingTriggered = true
    // 确保 AI 配置已就绪（SetupWizard 完成后才会到这里）
    if (!configStore.hasAiConfig) return
    clearComposerDraft()
    await runAgent('__onboarding__')
  },
  { immediate: true }
)

// ==================== 诊断和分析（通过 Agent 执行） ====================

// 诊断错误（通过 Agent 执行）
const handleDiagnoseError = () => {
  const error = lastError.value
  if (!error || isLoading.value) return
  
  // 清除错误提示
  if (terminalStore.activeTab) {
    terminalStore.clearError(terminalStore.activeTab.id)
  }
  
  // 设置输入文本为诊断提示
  // 通过 Agent 执行分析
  clearComposerDraft()
  void runAgent(`${t('ai.analyzeErrorPrompt')}\n\`\`\`\n${error.content}\n\`\`\``)
}

// 分析选中内容（通过 Agent 执行）
const handleAnalyzeSelection = () => {
  const selection = terminalSelectedText.value
  if (!selection || isLoading.value) return
  
  // 设置输入文本为分析提示
  // 通过 Agent 执行分析
  clearComposerDraft()
  void runAgent(`${t('ai.analyzeOutputPrompt')}\n\`\`\`\n${selection}\n\`\`\``)
}

// ==================== 拖放处理 ====================

// 拖放进入
const handleDragEnter = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  // 检查是否有文件
  if (e.dataTransfer?.types.includes('Files')) {
    isDraggingOver.value = true
  }
}

// 拖放悬停
const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

// 拖放离开
const handleDragLeave = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  // 检查是否真的离开了容器（而不是进入子元素）
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    isDraggingOver.value = false
  }
}

// ==================== 图片预览（支持缩放、拖拽、键盘导航） ====================
const previewImageUrl = ref<string | null>(null)
const previewScale = ref(1)
const previewTranslateX = ref(0)
const previewTranslateY = ref(0)
const isDraggingImage = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartTranslateX = 0
let dragStartTranslateY = 0

// 当前预览在 allPreviewImages 中的位置，-1 表示不在对话图片列表中（如待发送的图片）
const previewGroupIdx = ref(-1)
const previewImageIdx = ref(-1)

interface PreviewImageGroup {
  groupId: string
  images: string[]
}

// 收集所有对话中的图片，按任务分组（用户图片 + 步骤图片合并到同一组）
const allPreviewImages = computed((): PreviewImageGroup[] => {
  const result: PreviewImageGroup[] = []
  for (const group of agentTaskGroups.value) {
    const images: string[] = []
    if (group.images?.length) images.push(...group.images)
    for (const step of group.steps) {
      if (step.images?.length) images.push(...step.images)
    }
    if (images.length > 0) {
      result.push({ groupId: group.id, images })
    }
  }
  return result
})

const resetPreviewTransform = () => {
  previewScale.value = 1
  previewTranslateX.value = 0
  previewTranslateY.value = 0
}

const openImagePreview = (url: string) => {
  previewImageUrl.value = url
  resetPreviewTransform()
  previewGroupIdx.value = -1
  previewImageIdx.value = -1
  for (let gi = 0; gi < allPreviewImages.value.length; gi++) {
    const imgIdx = allPreviewImages.value[gi].images.indexOf(url)
    if (imgIdx !== -1) {
      previewGroupIdx.value = gi
      previewImageIdx.value = imgIdx
      return
    }
  }
}

const closeImagePreview = () => {
  previewImageUrl.value = null
  isDraggingImage.value = false
}

const navigatePreview = (groupIdx: number, imageIdx: number) => {
  const groups = allPreviewImages.value
  if (groupIdx < 0 || groupIdx >= groups.length) return
  const group = groups[groupIdx]
  if (imageIdx < 0 || imageIdx >= group.images.length) return
  previewGroupIdx.value = groupIdx
  previewImageIdx.value = imageIdx
  previewImageUrl.value = group.images[imageIdx]
  resetPreviewTransform()
}

// 同组内左右切换
const canGoLeft = computed(() => previewImageIdx.value > 0)
const canGoRight = computed(() => {
  const g = allPreviewImages.value[previewGroupIdx.value]
  return g ? previewImageIdx.value < g.images.length - 1 : false
})
const canGoUp = computed(() => previewGroupIdx.value > 0)
const canGoDown = computed(() => previewGroupIdx.value >= 0 && previewGroupIdx.value < allPreviewImages.value.length - 1)

const goLeft = () => canGoLeft.value && navigatePreview(previewGroupIdx.value, previewImageIdx.value - 1)
const goRight = () => canGoRight.value && navigatePreview(previewGroupIdx.value, previewImageIdx.value + 1)
const goUp = () => {
  if (!canGoUp.value) return
  const prevGroup = allPreviewImages.value[previewGroupIdx.value - 1]
  navigatePreview(previewGroupIdx.value - 1, prevGroup.images.length - 1)
}
const goDown = () => canGoDown.value && navigatePreview(previewGroupIdx.value + 1, 0)

const currentGroupImageCount = computed(() => allPreviewImages.value[previewGroupIdx.value]?.images.length ?? 0)

// 滚轮缩放
const handlePreviewWheel = (e: WheelEvent) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  const newScale = Math.max(0.1, Math.min(10, previewScale.value + delta * previewScale.value))
  previewScale.value = newScale
}

// 双击重置
const handlePreviewDblClick = () => resetPreviewTransform()

// 拖拽平移
const handlePreviewMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return
  e.preventDefault()
  isDraggingImage.value = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartTranslateX = previewTranslateX.value
  dragStartTranslateY = previewTranslateY.value
  
  const handleMouseMove = (ev: MouseEvent) => {
    if (!isDraggingImage.value) return
    previewTranslateX.value = dragStartTranslateX + (ev.clientX - dragStartX)
    previewTranslateY.value = dragStartTranslateY + (ev.clientY - dragStartY)
  }
  const handleMouseUp = () => {
    isDraggingImage.value = false
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)
}

// 预览图片的 transform 样式
const previewTransform = computed(() => {
  return `translate(${previewTranslateX.value}px, ${previewTranslateY.value}px) scale(${previewScale.value})`
})

// 拖放放下（支持文档和图片）
const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = false
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    // 先处理图片文件
    const imageCount = await handleDroppedImages(files)
    // 剩余的非图片文件交给文档处理
    if (imageCount < files.length) {
      await handleDroppedFiles(files)
    }
  }
}

// ==================== 键盘事件处理 ====================

const handleKeyDown = (e: KeyboardEvent) => {
  // 图片预览模式下的键盘操作
  if (previewImageUrl.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (previewScale.value !== 1 || previewTranslateX.value !== 0 || previewTranslateY.value !== 0) {
        resetPreviewTransform()
      } else {
        closeImagePreview()
      }
      return
    }
    // 缩放状态下方向键用于平移，未缩放时用于图片导航
    if (previewScale.value !== 1) {
      const PAN_STEP = 50
      if (e.key === 'ArrowLeft') { e.preventDefault(); previewTranslateX.value += PAN_STEP; return }
      if (e.key === 'ArrowRight') { e.preventDefault(); previewTranslateX.value -= PAN_STEP; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); previewTranslateY.value += PAN_STEP; return }
      if (e.key === 'ArrowDown') { e.preventDefault(); previewTranslateY.value -= PAN_STEP; return }
    } else {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goLeft(); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); goRight(); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); goUp(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); goDown(); return }
    }
    return
  }
  // ESC 键关闭弹窗
  if (e.key === 'Escape') {
    if (showHistoryModal.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      closeHistoryModal()
    }
  }
}

// ==================== 生命周期 ====================

watch(scrollerRef, (scroller, oldScroller) => {
  const oldEl = oldScroller?.$el as HTMLElement | undefined
  if (oldEl) {
    oldEl.removeEventListener('scroll', updateScrollPosition)
    oldEl.removeEventListener('click', handleCodeBlockClick)
    oldEl.removeEventListener('contextmenu', handleFilePathContextMenu)
  }
  const el = scroller?.$el as HTMLDivElement | undefined
  messagesRef.value = el ?? null
  if (el) {
    el.addEventListener('scroll', updateScrollPosition, { passive: true })
    el.addEventListener('click', handleCodeBlockClick)
    el.addEventListener('contextmenu', handleFilePathContextMenu)
  }
}, { flush: 'post' })

const getPreviewHints = (attachments?: { totalPages?: number; previewPages?: number; filename: string }[]) => {
  if (!attachments) return []
  return attachments.filter(a => a.totalPages && a.previewPages && a.totalPages! > a.previewPages!)
}

const getItemSizeDeps = (item: typeof flattenedItems.value[0]) => {
  if (item.type === 'step' && item.step) {
    return [item.step.content, item.step.toolResult, item.step.isStreaming, item.step.images?.length]
  }
  if (item.type === 'final_result' && item.group) return [item.group.finalResult]
  if (item.type === 'proactive_message' && item.group) return [item.group.finalResult]
  if (item.type === 'confirm') return [pendingConfirm.value?.toolCallId, pendingConfirm.value?.toolArgs]
  return []
}

const warmupMessageList = () => {
  if (!import.meta.env.DEV) return

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollerRef.value?.forceUpdate?.(true)
    })
  })
}

onMounted(() => {
  isMounted.value = true
  loadHostProfile()
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('keydown', handlePTTKeyDown)
  document.addEventListener('keyup', handlePTTKeyUp)
  window.addEventListener('blur', handlePTTWindowBlur)

  // 音频设备检测和 toast 已提升到 App.vue 全局执行一次
  // 这里只需在模型尚未就绪时尝试初始化（幂等，全局共享 Promise）
  if (configStore.keyboardShortcuts.voiceInput && audioAvailable.value) {
    initSpeech()
  }

  warmupMessageList()
})

onUnmounted(() => {
  clearPTTStopTimer()
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('keydown', handlePTTKeyDown)
  document.removeEventListener('keyup', handlePTTKeyUp)
  window.removeEventListener('blur', handlePTTWindowBlur)
  const el = scrollerRef.value?.$el as HTMLElement | undefined
  if (el) {
    el.removeEventListener('scroll', updateScrollPosition)
    el.removeEventListener('click', handleCodeBlockClick)
    el.removeEventListener('contextmenu', handleFilePathContextMenu)
  }
})

watch(() => props.visible, (visible) => {
  if (visible) {
    warmupMessageList()
  }
}, { flush: 'post' })
</script>

<template>
  <div 
    class="ai-panel"
    :class="{
      'mode-strict': executionMode === 'strict',
      'mode-relaxed': executionMode === 'relaxed',
      'mode-free': executionMode === 'free'
    }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖放提示覆盖层 -->
    <div v-if="isDraggingOver" class="drop-overlay">
      <div class="drop-content">
        <Upload :size="48" :stroke-width="1.5" />
        <p>{{ t('ai.dropToUpload') }}</p>
        <span class="drop-hint">{{ t('ai.dropHint') }}</span>
      </div>
    </div>

    <div class="ai-header">
      <h3>{{ t('ai.assistant') }}</h3>
      <div class="ai-header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          class="model-select"
          :value="activeAiProfile?.id || ''"
          :title="t('ai.switchModel')"
          @change="changeAiProfile(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }}){{ profile.modelType === 'vision' ? ` [${t('aiSettings.modelTypeVision')}]` : '' }}
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" :title="t('ai.clearChat')">
          <Trash2 :size="16" />
        </button>
        <button class="btn-icon" @click="handleClose" :title="t('ai.closePanel')">
          <X :size="16" />
        </button>
      </div>
    </div>

    <!-- 未配置 AI 提示 -->
    <div v-if="!hasAiConfig" class="ai-no-config">
      <HelpCircle :size="48" :stroke-width="1.5" />
      <p>{{ t('ai.noConfig') }}</p>
      <button class="btn btn-primary btn-sm" @click="showSettings?.()">
        {{ t('ai.goToSettings') }}
      </button>
    </div>

    <template v-else>
      <!-- 自由模式确认对话框 -->
      <div v-if="showFreeModeConfirm" class="free-mode-confirm-overlay">
        <div class="free-mode-confirm-dialog">
          <div class="confirm-dialog-header">
            <span class="confirm-dialog-icon">⚠️</span>
            <span class="confirm-dialog-title">{{ t('ai.freeModeConfirmTitle') }}</span>
          </div>
          <div class="confirm-dialog-content">
            <p>{{ t('ai.freeModeConfirmDesc') }}</p>
            <ul class="confirm-dialog-warnings">
              <li>{{ t('ai.freeModeWarning1') }}</li>
              <li>{{ t('ai.freeModeWarning2') }}</li>
              <li>{{ t('ai.freeModeWarning3') }}</li>
            </ul>
          </div>
          <div class="confirm-dialog-actions">
            <button class="btn btn-sm btn-outline" @click="cancelFreeMode">
              {{ t('common.no') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="confirmEnableFreeMode">
              {{ t('common.yes') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 清空对话确认对话框（Agent 执行中） -->
      <div v-if="showClearConfirm" class="free-mode-confirm-overlay">
        <div class="free-mode-confirm-dialog clear-confirm-dialog">
          <div class="confirm-dialog-header">
            <span class="confirm-dialog-icon">⚠️</span>
            <span class="confirm-dialog-title">{{ t('ai.clearConfirmTitle') }}</span>
          </div>
          <div class="confirm-dialog-content">
            <p>{{ t('ai.clearConfirmDesc') }}</p>
            <ul class="confirm-dialog-warnings">
              <li>{{ t('ai.clearConfirmWarning1') }}</li>
              <li>{{ t('ai.clearConfirmWarning2') }}</li>
            </ul>
          </div>
          <div class="confirm-dialog-actions">
            <button class="btn btn-sm btn-outline" @click="cancelClearMessages">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="confirmClearMessages">
              {{ t('ai.clearConfirmButton') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 系统环境信息 + Agent 设置 -->
      <div class="system-info-bar">
        <div v-if="currentSystemInfo" class="system-info-left host-info-trigger">
          <span class="system-icon">💻</span>
          <span class="system-text">
            {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
            · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
          </span>
          <span class="hover-hint">▾</span>
          
          <!-- 悬浮主机信息面板 -->
          <div class="host-info-popover">
            <div class="popover-header">
              <span>🖥️ {{ t('ai.agentWelcome.hostInfo') }}</span>
              <button 
                class="refresh-btn" 
                @click.stop="refreshHostProfile" 
                :disabled="isProbing"
                :title="isProbing ? t('ai.agentWelcome.probing') : t('ai.agentWelcome.refreshHost')"
              >
                <span :class="{ spinning: isProbing }">🔄</span>
              </button>
            </div>
            <div v-if="currentHostProfile" class="popover-content">
              <div class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.hostname') }}:</span>
                <span class="info-value">{{ currentHostProfile.hostname || t('common.unknown') }}</span>
                <span v-if="currentHostProfile.username" class="info-secondary">@ {{ currentHostProfile.username }}</span>
              </div>
              <div v-if="currentHostProfile.osVersion || currentHostProfile.os" class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.system') }}:</span>
                <span class="info-value">{{ currentHostProfile.osVersion || currentHostProfile.os }}</span>
              </div>
              <div v-if="currentHostProfile.shell" class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.shell') }}:</span>
                <span class="info-value">{{ currentHostProfile.shell }}</span>
                <span v-if="currentHostProfile.packageManager" class="info-secondary">| {{ currentHostProfile.packageManager }}</span>
              </div>
              <div v-if="currentHostProfile.installedTools?.length" class="info-row tools-row">
                <span class="info-label">{{ t('ai.agentWelcome.tools') }}:</span>
                <span class="info-value tools-list">{{ currentHostProfile.installedTools.join(', ') }}</span>
              </div>
            </div>
            <div v-else-if="isLoadingProfile" class="popover-loading">
              {{ t('common.loading') }}
            </div>
            <div v-else class="popover-empty">
              {{ t('ai.agentWelcome.notProbed') }}
            </div>
          </div>
        </div>
        <!-- Agent 模式设置 -->
        <div class="agent-settings">
          <!-- 超时设置 -->
          <div class="timeout-setting" :title="t('ai.timeout')">
            <span class="timeout-label">{{ t('ai.timeout') }}</span>
            <select v-model.number="commandTimeout" class="timeout-select">
              <option :value="5">5s</option>
              <option :value="10">10s</option>
              <option :value="30">30s</option>
              <option :value="60">60s</option>
              <option :value="120">2m</option>
              <option :value="300">5m</option>
            </select>
          </div>
          <!-- 执行模式选择器（三选一：严格/宽松/自由） -->
          <div class="execution-mode-selector">
            <button 
              class="mode-option" 
              :class="{ active: executionMode === 'strict' }"
              @click="switchToStrictMode"
              :title="t('ai.strictModeTitle')"
            >
              {{ t('ai.strict') }}
            </button>
            <button 
              class="mode-option" 
              :class="{ active: executionMode === 'relaxed' }"
              @click="switchToRelaxedMode"
              :title="t('ai.relaxedModeTitle')"
            >
              {{ t('ai.relaxed') }}
            </button>
            <button 
              class="mode-option mode-option-free" 
              :class="{ active: executionMode === 'free' }"
              @click="executionMode === 'free' ? switchToStrictMode() : requestFreeMode()"
              :title="t('ai.freeModeTitle')"
            >
              {{ t('ai.free') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 错误诊断提示（Agent 执行时隐藏） -->
      <div v-if="lastError && !isAgentRunning" class="error-alert">
        <div class="error-alert-icon">⚠️</div>
        <div class="error-alert-content">
          <div class="error-alert-title">{{ t('ai.errorDetected') }}</div>
          <div class="error-alert-text">{{ lastError.content.slice(0, 80) }}{{ lastError.content.length > 80 ? '...' : '' }}</div>
        </div>
        <button class="error-alert-btn" @click="handleDiagnoseError" :disabled="isLoading">
          {{ t('ai.aiDiagnose') }}
        </button>
        <button class="error-alert-close" @click="terminalStore.clearError(currentTabId)" :title="t('ai.closeError')">
          <X :size="14" />
        </button>
      </div>

      <!-- 终端选中内容提示（Agent 执行时隐藏） -->
      <div v-if="terminalSelectedText && !lastError && !isAgentRunning" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">{{ t('ai.selectedContent') }}</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="handleAnalyzeSelection" :disabled="isLoading">
          {{ t('ai.aiAnalyze') }}
        </button>
      </div>

      <!-- Plan 固定顶部区域 -->
      <div v-if="currentPlan" class="plan-sticky-header">
        <AgentPlanView 
          :plan="currentPlan" 
          :compact="!planExpanded" 
          @toggle="planExpanded = !planExpanded" 
        />
      </div>

      <!-- 消息列表（虚拟滚动） -->
      <!-- 隔离消息区渲染，避免 inputText 变化拖着整块历史列表一起重渲染 -->
      <div
        class="ai-messages-wrapper"
        v-memo="[
          flattenedItems,
          agentTaskGroups.length,
          agentUserTask,
          recentHistory,
          showHistoryModal,
          allHistory,
          hasMoreHistory,
          isLoadingHistory,
          isLoadingAllHistory,
          executionMode,
          isStandaloneAssistant,
          hasNewMessage
        ]"
      >
        <DynamicScroller
          ref="scrollerRef"
          :items="flattenedItems"
          :min-item-size="36"
          :buffer="800"
          :prerender="10"
          key-field="id"
          class="ai-messages"
          :class="{ 'standalone-mode': isStandaloneAssistant, 'custom-avatar': isStandaloneAssistant && configStore.agentAvatar }"
          :style="isStandaloneAssistant ? { '--assistant-avatar': `url(${configStore.agentAvatar || sailfishLogo})` } : undefined"
        >
          <template #before>
            <!-- 欢迎页（无任务且无历史对话时显示） -->
            <div v-if="!agentUserTask && agentTaskGroups.length === 0" class="ai-welcome">
              <p>🤖 {{ t('ai.agentWelcome.enabled') }}</p>

              <p class="welcome-section-title">💡 {{ t('ai.agentWelcome.whatIsAgent') }}</p>
              <p class="welcome-desc">{{ isStandaloneAssistant ? t('ai.agentWelcome.standaloneDesc') : t('ai.agentWelcome.agentDesc') }}</p>
              
              <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
              <ul v-if="isStandaloneAssistant">
                <li>{{ t('ai.agentWelcome.standaloneExample1') }}</li>
                <li>{{ t('ai.agentWelcome.standaloneExample2') }}</li>
                <li>{{ t('ai.agentWelcome.standaloneExample3') }}</li>
                <li>{{ t('ai.agentWelcome.standaloneExample4') }}</li>
              </ul>
              <ul v-else>
                <li>{{ t('ai.agentWelcome.example1') }}</li>
                <li>{{ t('ai.agentWelcome.example2') }}</li>
                <li>{{ t('ai.agentWelcome.example3') }}</li>
                <li>{{ t('ai.agentWelcome.example4') }}</li>
              </ul>

              <p class="welcome-section-title">
                <template v-if="executionMode === 'free'">🔥 {{ t('ai.agentWelcome.freeMode') }} <span class="strict-badge free">{{ t('ai.agentWelcome.freeModeOn') }}</span></template>
                <template v-else-if="executionMode === 'strict'">🔒 {{ t('ai.agentWelcome.strictMode') }} <span class="strict-badge">{{ t('ai.agentWelcome.strictModeOn') }}</span></template>
                <template v-else>🔓 {{ t('ai.agentWelcome.relaxedMode') }} <span class="strict-badge relaxed">{{ t('ai.agentWelcome.relaxedModeOn') }}</span></template>
              </p>
              <ul>
                <li v-if="executionMode === 'free'"><strong class="warning-text">{{ t('ai.agentWelcome.freeModeDesc1') }}</strong></li>
                <li v-if="executionMode === 'free'">{{ t('ai.agentWelcome.freeModeDesc2') }}</li>
                <li v-if="executionMode === 'strict'"><strong>{{ t('ai.agentWelcome.strictModeDesc1') }}</strong></li>
                <li v-if="executionMode === 'strict'">{{ t('ai.agentWelcome.strictModeDesc2') }}</li>
                <li v-if="executionMode === 'relaxed'"><strong>{{ t('ai.agentWelcome.relaxedModeDesc1') }}</strong></li>
                <li v-if="executionMode === 'relaxed'">{{ t('ai.agentWelcome.relaxedModeDesc2') }}</li>
                <li>{{ isStandaloneAssistant ? t('ai.agentWelcome.standaloneAllCommandsVisible') : t('ai.agentWelcome.allCommandsVisible') }}</li>
              </ul>

              <p class="welcome-section-title">⚠️ {{ t('ai.agentWelcome.cautions') }}</p>
              <ul v-if="isStandaloneAssistant">
                <li>{{ t('ai.agentWelcome.standaloneCaution1') }}</li>
                <li>{{ t('ai.agentWelcome.standaloneCaution2') }}</li>
              </ul>
              <ul v-else>
                <li>{{ t('ai.agentWelcome.caution1') }}</li>
                <li>{{ t('ai.agentWelcome.caution2') }}</li>
              </ul>

              <!-- 最近对话历史 -->
              <div class="recent-history-section">
                <p class="welcome-section-title">📜 {{ t('ai.agentWelcome.recentHistory') }}</p>
                
                <div v-if="isLoadingHistory" class="history-loading">
                  {{ t('ai.agentWelcome.historyLoading') }}
                </div>
                
                <div v-else-if="recentHistory.length === 0" class="history-empty">
                  {{ t('ai.agentWelcome.noRecentHistory') }}
                </div>
                
                <div v-else class="history-list">
                  <div 
                    v-for="record in recentHistory" 
                    :key="record.id" 
                    class="history-card"
                    @click="handleLoadHistory(record)"
                  >
                    <span class="history-status-icon" :class="record.status">
                      {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
                    </span>
                    <span class="history-task">{{ truncateText(record.userTask, 50) }}</span>
                    <span class="history-meta">
                      <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
                      <span class="history-time">{{ formatHistoryTime(record.timestamp + record.duration) }}</span>
                    </span>
                  </div>
                </div>
                
                <button 
                  v-if="recentHistory.length > 0" 
                  class="view-more-btn"
                  @click="openHistoryModal"
                >
                  {{ t('ai.agentWelcome.viewMoreHistory') }}
                </button>
              </div>
            </div>

            <!-- 历史对话弹窗 -->
            <div v-if="showHistoryModal" class="history-modal-overlay" @click.self="closeHistoryModal">
              <div class="history-modal">
                <div class="history-modal-header">
                  <h3>📜 {{ t('ai.agentWelcome.recentHistory') }}</h3>
                  <button class="history-modal-close" @click="closeHistoryModal">×</button>
                </div>
                <div class="history-modal-body">
                  <div v-if="isLoadingAllHistory" class="history-loading">
                    {{ t('ai.agentWelcome.historyLoading') }}
                  </div>
                  <div v-else-if="allHistory.length === 0" class="history-empty">
                    {{ t('ai.agentWelcome.noRecentHistory') }}
                  </div>
                  <div v-else class="history-modal-list">
                    <div 
                      v-for="record in allHistory" 
                      :key="record.id" 
                      class="history-card"
                      @click="handleLoadHistory(record)"
                    >
                      <span class="history-status-icon" :class="record.status">
                        {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
                      </span>
                      <span class="history-task">{{ truncateText(record.userTask, 80) }}</span>
                      <span class="history-meta">
                        <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
                        <span class="history-time">{{ formatHistoryTime(record.timestamp + record.duration) }}</span>
                      </span>
                    </div>
                    <button
                      v-if="hasMoreHistory"
                      class="history-load-more"
                      :disabled="isLoadingAllHistory"
                      @click="loadMoreHistory"
                    >
                      {{ isLoadingAllHistory ? t('ai.agentWelcome.historyLoading') : t('ai.agentWelcome.loadMore', '加载更多...') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <template #default="{ item, index, active }">
            <DynamicScrollerItem :item="item" :active="active" :data-index="index" :size-dependencies="getItemSizeDeps(item)">

              <!-- 主动消息 -->
              <div v-if="item.type === 'proactive_message'" class="message assistant">
                <div class="message-wrapper">
                  <div class="message-content markdown-content" v-html="renderMarkdown(item.group!.finalResult!)"></div>
                </div>
              </div>

              <!-- 用户任务 -->
              <div v-else-if="item.type === 'user_task'" class="message user">
                <div class="message-wrapper">
                  <div class="message-content">
                    <span>{{ item.group!.userTask }}</span>
                    <div v-if="item.group!.images && item.group!.images.length > 0" class="message-images">
                      <img 
                        v-for="(imgUrl, imgIdx) in item.group!.images" 
                        :key="imgIdx" 
                        :src="imgUrl" 
                        class="message-image" 
                        @click="openImagePreview(imgUrl)"
                      />
                    </div>
                    <div 
                      v-for="hint in getPreviewHints(item.group!.attachments)"
                      :key="hint.filename"
                      class="image-preview-hint"
                    >
                      仅预览前 {{ hint.previewPages }} 页（共 {{ hint.totalPages }} 页）
                    </div>
                    <div v-if="item.group!.attachments && item.group!.attachments.length > 0" class="message-attachments">
                      <span 
                        v-for="(file, fileIdx) in item.group!.attachments" 
                        :key="fileIdx" 
                        class="attachment-chip"
                        :title="file.filePath || file.filename"
                      >
                        <span class="attachment-name">📎 {{ file.filename }}</span>
                        <span class="attachment-size">{{ formatFileSize(file.fileSize) }}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Agent 初始加载（无步骤时） -->
              <div v-else-if="item.type === 'agent_loading'" class="message assistant">
                <div class="message-wrapper">
                  <div class="message-content agent-initial-loading">
                    <div class="agent-thinking-indicator">
                      <span class="thinking-spinner"></span>
                      <span class="thinking-text">{{ t('ai.agentStarting') }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 单个步骤 -->
              <div v-else-if="item.type === 'step'" class="agent-step-virtual" :class="{ 'first-step': item.isFirstStep }">
                <div 
                  class="agent-step-inline"
                  :class="[item.step!.type, getRiskClass(item.step!.riskLevel), { 'step-rejected': item.step!.content.includes('拒绝') }]"
                >
                  <span class="step-icon">{{ getStepIcon(item.step!.type) }}</span>
                  <div class="step-content">
                    <div 
                      v-if="item.step!.type === 'message'" 
                      class="step-text step-analysis markdown-content"
                      :class="{ 'is-streaming': item.step!.isStreaming }"
                      v-html="renderMarkdown(item.step!.content)"
                    ></div>
                    <div v-else-if="item.step!.type === 'asking'" class="step-text asking-content">
                      <div class="asking-question">{{ item.step!.content }}</div>
                      <div v-if="item.step!.toolArgs?.default_value" class="asking-default">
                        <span class="default-label">{{ t('ai.askingDefault') }}</span>{{ item.step!.toolArgs.default_value }}
                        <span v-if="item.step!.toolResult?.includes('⏳')" class="default-hint">{{ t('ai.askingDefaultHint') }}</span>
                      </div>
                      <div v-if="item.step!.toolArgs?.options && (item.step!.toolArgs.options as string[]).length > 0" class="asking-options">
                        <button 
                          v-for="(opt, optIdx) in (item.step!.toolArgs.options as string[]).slice(0, 10)" 
                          :key="optIdx"
                          class="asking-option-btn"
                          :class="{ 
                            'selected': item.step!.toolResult?.includes(opt) || getSelectedOptions(item.step!.id).includes(opt),
                            'clicking': clickingOption === opt && item.step!.toolResult?.includes('⏳') && !item.step!.toolArgs?.allow_multiple
                          }"
                          :disabled="!isAgentRunning || item.step!.toolResult?.includes('✅') || item.step!.toolResult?.includes('⏰') || item.step!.toolResult?.includes('🛑')"
                          @click="handleOptionClick(item.step!.id, opt, !!item.step!.toolArgs?.allow_multiple)"
                        >
                          <span class="option-label">{{ String.fromCharCode(65 + optIdx) }}</span>
                          {{ opt }}
                        </button>
                        <button 
                          v-if="item.step!.toolArgs?.allow_multiple && item.step!.toolResult?.includes('⏳')"
                          class="asking-confirm-btn"
                          :disabled="getSelectedOptions(item.step!.id).length === 0"
                          @click="confirmMultiSelect(item.step!.id)"
                        >
                          {{ t('ai.confirmMultiSelect') }} ({{ getSelectedOptions(item.step!.id).length }})
                        </button>
                      </div>
                      <div v-if="item.step!.toolResult && !item.step!.toolResult.includes('✅')" class="asking-status" :class="{ 
                        'status-waiting': item.step!.toolResult.includes('⏳'),
                        'status-timeout': item.step!.toolResult.includes('⏰'),
                        'status-cancelled': item.step!.toolResult.includes('🛑')
                      }">
                        {{ item.step!.toolResult }}
                      </div>
                    </div>
                    <div v-else-if="item.step!.type === 'plan_created' || item.step!.type === 'plan_updated' || item.step!.type === 'plan_archived'" class="step-text plan-step-content">
                      <div class="plan-step-header" @click="togglePlanExpand(item.step!.id)">
                        <span class="plan-step-text">{{ item.step!.content }}</span>
                        <span class="plan-expand-icon" :class="{ expanded: expandedPlanSteps.has(item.step!.id) }">▶</span>
                      </div>
                      <div v-if="expandedPlanSteps.has(item.step!.id) && item.step!.plan" class="plan-step-details">
                        <AgentPlanView :plan="item.step!.plan" :compact="false" />
                      </div>
                    </div>
                    <div v-else class="step-text markdown-content" v-html="renderMarkdown(item.step!.content)"></div>
                    <!-- 并行子 Agent 卡片组 -->
                    <div v-if="item.step!.subAgents && item.step!.subAgents.length > 0" class="sub-agents-group">
                      <div
                        v-for="sa in item.step!.subAgents"
                        :key="sa.id"
                        class="sub-agent-card"
                        :class="sa.status"
                      >
                        <div class="sub-agent-header" @click="toggleSubAgentExpand(item.step!.id + ':' + sa.id)">
                          <span class="sub-agent-status-icon">
                            <span v-if="sa.status === 'pending'" class="sa-icon-pending">○</span>
                            <span v-else-if="sa.status === 'running'" class="sa-icon-running">◌</span>
                            <span v-else-if="sa.status === 'completed'" class="sa-icon-completed">✓</span>
                            <span v-else class="sa-icon-failed">✗</span>
                          </span>
                          <span class="sub-agent-header-text">
                            <span class="sub-agent-desc">{{ sa.description }}</span>
                            <span v-if="sa.status === 'running' && getSubAgentActivity(sa)" class="sub-agent-activity">⟳ {{ getSubAgentActivity(sa) }}</span>
                          </span>
                          <span class="sub-agent-status-text">
                            {{ t(`ai.subAgent${sa.status.charAt(0).toUpperCase() + sa.status.slice(1)}`) }}
                          </span>
                          <span v-if="sa.prompt || sa.result || sa.error || (sa.steps && sa.steps.length > 0)" class="sub-agent-expand-icon" :class="{ expanded: isSubAgentExpanded(item.step!.id + ':' + sa.id) }">▶</span>
                        </div>
                        <div v-if="isSubAgentExpanded(item.step!.id + ':' + sa.id)" class="sub-agent-detail">
                          <div v-if="sa.prompt" class="sub-agent-prompt">{{ sa.prompt }}</div>
                          <div v-if="sa.steps && sa.steps.length > 0" class="sub-agent-steps">
                            <div v-for="(step, stepIdx) in sa.steps" :key="stepIdx" class="sa-step" :class="step.status">
                              <span class="sa-step-icon">
                                <span v-if="step.status === 'running'" class="sa-step-running">⟳</span>
                                <span v-else-if="step.status === 'completed'" class="sa-step-done">✓</span>
                                <span v-else class="sa-step-fail">✗</span>
                              </span>
                              <span class="sa-step-tool">{{ step.tool }}</span>
                              <span v-if="step.args" class="sa-step-args">{{ step.args }}</span>
                            </div>
                          </div>
                          <div v-if="sa.result" class="sub-agent-result">
                            <pre>{{ sa.result }}</pre>
                          </div>
                          <div v-if="sa.error" class="sub-agent-result">
                            <pre class="sub-agent-error">{{ sa.error }}</pre>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-if="item.step!.type === 'user_supplement' && item.step!.attachments && item.step!.attachments.length > 0" class="message-attachments">
                      <span
                        v-for="(file, fileIdx) in item.step!.attachments"
                        :key="fileIdx"
                        class="attachment-chip"
                        :title="file.filePath || file.filename"
                      >
                        <span class="attachment-name">📎 {{ file.filename }}</span>
                        <span class="attachment-size">{{ formatFileSize(file.fileSize) }}</span>
                      </span>
                    </div>
                    <div v-if="item.step!.toolResult && item.step!.toolResult !== '已拒绝' && item.step!.toolResult !== item.step!.content && item.step!.type !== 'asking' && !item.step!.subAgents" class="step-result">
                      <pre>{{ item.step!.toolResult }}</pre>
                    </div>
                    <div v-if="item.step!.images && item.step!.images.length > 0" class="step-images">
                      <img
                        v-for="(imgUrl, imgIdx) in item.step!.images"
                        :key="imgIdx"
                        :src="imgUrl"
                        :alt="item.step!.toolResult || `image ${imgIdx + 1}`"
                        class="step-image"
                        @click="openImagePreview(imgUrl)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 思考中指示器 -->
              <div v-else-if="item.type === 'thinking_indicator'" class="agent-step-virtual">
                <div class="agent-thinking-indicator">
                  <span class="thinking-spinner"></span>
                  <span class="thinking-text">{{ t('ai.preparing') }}</span>
                </div>
              </div>

              <!-- 最终结果 -->
              <div v-else-if="item.type === 'final_result'" class="message assistant">
                <div class="message-wrapper agent-final-wrapper">
                  <div class="message-content agent-final-content" :class="{ 'is-error': item.group!.finalResult!.startsWith('❌'), 'is-aborted': item.group!.finalResult!.startsWith('⚠️') }">
                    <div class="agent-final-header">
                      <span class="final-icon">{{ item.group!.finalResult!.startsWith('❌') ? '❌' : item.group!.finalResult!.startsWith('⚠️') ? '⚠️' : '✅' }}</span>
                      <span class="final-title">{{ item.group!.finalResult!.startsWith('❌') ? t('ai.taskFailed') : item.group!.finalResult!.startsWith('⚠️') ? t('ai.taskAborted') : t('ai.taskComplete') }}</span>
                    </div>
                    <div class="agent-final-body markdown-content" v-html="renderMarkdown(item.group!.finalResult!.replace(/^[❌✅⚠️]\s*(Agent\s*(执行失败|运行出错)[:\s]*)?/, ''))"></div>
                  </div>
                </div>
              </div>

              <!-- 确认对话框 -->
              <div v-else-if="item.type === 'confirm' && pendingConfirm" class="agent-step-virtual">
                <div class="agent-confirm-inline" :class="getRiskClass(pendingConfirm.riskLevel)">
                  <div class="confirm-header-inline">
                    <span class="confirm-icon">{{ pendingConfirm.riskLevel === 'dangerous' ? '🔴' : (pendingConfirm.riskLevel === 'moderate' ? '🟡' : '🟢') }}</span>
                    <span class="confirm-title">{{ t('ai.needConfirm') }}</span>
                    <span class="confirm-risk-badge" :class="getRiskClass(pendingConfirm.riskLevel)">
                      {{ pendingConfirm.riskLevel === 'dangerous' ? t('ai.highRisk') : (pendingConfirm.riskLevel === 'moderate' ? t('ai.mediumRisk') : t('ai.lowRisk')) }}
                    </span>
                  </div>
                  <div class="confirm-detail">
                    <div class="confirm-tool-name">{{ getToolDisplayName(pendingConfirm.toolName) }}</div>
                    <pre class="confirm-args-inline">{{ formatConfirmArgs(pendingConfirm) }}</pre>
                  </div>
                  <div class="confirm-actions-inline">
                    <button class="btn btn-sm btn-outline-secondary" @click="confirmToolCall(false)">
                      {{ t('ai.reject') }}
                    </button>
                    <button 
                      class="btn btn-sm" 
                      :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-outline-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-outline-warning' : 'btn-outline-success')"
                      @click="confirmToolCall(true, true)"
                      :title="t('ai.alwaysAllowHint')"
                    >
                      {{ t('ai.alwaysAllow') }}
                    </button>
                    <button 
                      class="btn btn-sm" 
                      :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-warning' : 'btn-success')"
                      @click="confirmToolCall(true)"
                    >
                      {{ t('ai.allowExecute') }}
                    </button>
                  </div>
                </div>
              </div>

            </DynamicScrollerItem>
          </template>
        </DynamicScroller>


        <!-- 新消息指示器 -->
        <div v-if="hasNewMessage" class="new-message-indicator" @click="scrollToBottom" :title="t('ai.newMessage')">
          <ChevronDown :size="14" />
          <span>{{ t('ai.newMessage') }}</span>
        </div>
      </div>


      <AiComposer
        ref="composerRef"
        :current-tab-id="currentTabId"
        :visible="props.visible"
        :context-stats="contextStats"
        :cache-bar-width="cacheBarWidth"
        :uploaded-docs="uploadedDocs"
        :pending-images="pendingImages"
        :is-attaching="isAttaching"
        :is-agent-running="isAgentRunning"
        :is-loading="isLoading"
        :can-send-empty="canSendEmpty"
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
        :stop-generation="stopGeneration"
        :abort-agent="abortAgent"
        :tts-is-speaking="ttsIsSpeaking ?? false"
        :tts-stop="ttsStop"
        :submit-message="handleComposerSubmit"
        :submit-empty-message="handleComposerEmptySubmit"
        :clear-tab-error="clearTabError"
      />
    </template>
    <!-- 图片预览弹窗（支持缩放拖拽、键盘导航） -->
    <div 
      v-if="previewImageUrl" 
      class="image-preview-modal" 
      @click="closeImagePreview"
      @wheel.prevent="handlePreviewWheel"
    >
      <!-- 上方导航箭头：历史对话 -->
      <button v-if="canGoUp" class="image-preview-nav nav-up" @click.stop="goUp" :title="t('ai.imagePreview.prevConversation')">
        <ChevronUp :size="24" />
      </button>
      <!-- 左侧导航箭头：同组前一张 -->
      <button v-if="canGoLeft" class="image-preview-nav nav-left" @click.stop="goLeft" :title="t('ai.imagePreview.prevImage')">
        <ChevronLeft :size="24" />
      </button>
      <!-- 右侧导航箭头：同组后一张 -->
      <button v-if="canGoRight" class="image-preview-nav nav-right" @click.stop="goRight" :title="t('ai.imagePreview.nextImage')">
        <ChevronRight :size="24" />
      </button>
      <!-- 下方导航箭头：后续对话 -->
      <button v-if="canGoDown" class="image-preview-nav nav-down" @click.stop="goDown" :title="t('ai.imagePreview.nextConversation')">
        <ChevronDown :size="24" />
      </button>

      <div class="image-preview-modal-content" @click.stop>
        <button class="image-preview-close" @click="closeImagePreview">
          <X :size="20" />
        </button>
        <img 
          :src="previewImageUrl" 
          class="image-preview-full" 
          :class="{ 'dragging': isDraggingImage }"
          :style="{ transform: previewTransform }"
          @mousedown="handlePreviewMouseDown"
          @dblclick="handlePreviewDblClick"
          draggable="false"
        />
        <!-- 底部信息栏：图片位置 + 缩放比例 -->
        <div class="image-preview-info-bar">
          <span v-if="currentGroupImageCount > 1" class="image-preview-counter">
            {{ previewImageIdx + 1 }} / {{ currentGroupImageCount }}
          </span>
          <span v-if="previewScale !== 1" class="image-preview-zoom-badge">
            {{ Math.round(previewScale * 100) }}%
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  /* 入场动画 */
  animation: panelEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes panelEnter {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 拖放覆盖层 */
.drop-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 150, 255, 0.15);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 3px dashed var(--accent-primary);
  border-radius: 8px;
  animation: dropOverlayFadeIn 0.2s ease;
}

@keyframes dropOverlayFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.drop-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--accent-primary);
  text-align: center;
  padding: 24px;
  background: var(--bg-primary);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.drop-content svg {
  animation: dropIconBounce 0.5s ease infinite alternate;
}

@keyframes dropIconBounce {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-8px);
  }
}

.drop-content p {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.drop-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  position: relative;
  animation: headerEnter 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both;
}

@keyframes headerEnter {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 深色主题：头部底部微光 */
[data-color-scheme="dark"] .ai-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
}

.ai-header h3 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ai-header-actions .btn-icon {
  width: 28px;
  height: 28px;
  padding: 6px;
  border-radius: 6px;
}

.model-select {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  max-width: 160px;
  outline: none;
}

.model-select:hover {
  border-color: var(--accent-primary);
}

.model-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(0, 150, 255, 0.2);
}

.ai-no-config {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 20px;
  color: var(--text-muted);
  text-align: center;
}

.system-info-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
}

.system-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.system-icon {
  font-size: 12px;
}

.system-text {
  font-family: var(--font-mono);
}

/* 主机信息悬浮触发器 */
.host-info-trigger {
  position: relative;
  cursor: pointer;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.host-info-trigger:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.hover-hint {
  font-size: 8px;
  opacity: 0.5;
  margin-left: 2px;
  transition: all 0.2s ease;
}

.host-info-trigger:hover .hover-hint {
  opacity: 1;
  transform: translateY(1px);
}

/* 悬浮面板 */
.host-info-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  min-width: 380px;
  max-width: 380px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  z-index: 100;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-5px);
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 添加透明连接区域，让鼠标能顺利移动到面板 */
.host-info-popover::after {
  content: '';
  position: absolute;
  top: -10px;
  left: 0;
  right: 0;
  height: 10px;
}

.host-info-trigger:hover .host-info-popover,
.host-info-popover:hover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

/* 面板箭头 */
.host-info-popover::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 28px;
  width: 12px;
  height: 12px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
  transform: rotate(45deg);
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.refresh-btn {
  padding: 4px 6px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn .spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes gradient-flow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.popover-content {
  padding: 14px 16px;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.info-row:last-child {
  margin-bottom: 0;
}

.info-row.tools-row {
  flex-wrap: wrap;
}

.info-label {
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 55px;
}

.info-value {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-secondary {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-value.tools-list {
  color: var(--accent-primary);
  word-break: break-word;
}

.popover-loading,
.popover-empty {
  padding: 16px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

/* 错误诊断提示 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(244, 63, 94, 0.15);
  border-bottom: 1px solid rgba(244, 63, 94, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.error-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.error-alert-content {
  flex: 1;
  min-width: 0;
}

.error-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #f43f5e;
  margin-bottom: 2px;
}

.error-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #f43f5e;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-btn:hover:not(:disabled) {
  background: #e11d48;
}

.error-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-alert-close {
  padding: 4px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-close:hover {
  opacity: 1;
  background: rgba(244, 63, 94, 0.2);
}

/* 选中内容提示 */
.selection-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.15);
  border-bottom: 1px solid rgba(59, 130, 246, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.selection-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.selection-alert-content {
  flex: 1;
  min-width: 0;
}

.selection-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #3b82f6;
  margin-bottom: 2px;
}

.selection-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selection-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #3b82f6;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.selection-alert-btn:hover:not(:disabled) {
  background: #2563eb;
}

.selection-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Plan 固定顶部区域 */
.plan-sticky-header {
  flex-shrink: 0;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.ai-messages-wrapper {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.ai-messages {
  height: 100% !important;
  padding: 12px;
  user-select: text;
  position: relative;
  overflow-anchor: auto;
  transition: box-shadow 0.3s ease;
}

.agent-step-virtual {
  padding: 0 14px 4px;
  margin-left: 20px;
  border-left: 2px solid rgba(255, 255, 255, 0.06);
}

.standalone-mode .agent-step-virtual {
  margin-left: 48px;
}

.standalone-mode .agent-step-virtual.first-step {
  position: relative;
  padding-top: 4px;
}

.standalone-mode .agent-step-virtual.first-step::before {
  content: '';
  position: absolute;
  left: calc(-48px - 2px);
  top: 4px;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background-image: var(--assistant-avatar);
  background-size: 68%;
  background-position: center;
  background-repeat: no-repeat;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.standalone-mode.custom-avatar .agent-step-virtual.first-step::before {
  background-size: cover;
}

/* Agent 执行模式 - 宽松模式绿色内阴影（仅左右两边） */
.ai-panel.mode-relaxed .ai-messages {
  box-shadow: 
    inset 30px 0 30px -20px rgba(16, 185, 129, 0.35),
    inset -30px 0 30px -20px rgba(16, 185, 129, 0.35);
}

/* Agent 执行模式 - 自由模式红色内阴影 + 脉冲警示（仅左右两边） */
.ai-panel.mode-free .ai-messages {
  box-shadow: 
    inset 40px 0 40px -25px rgba(239, 68, 68, 0.4),
    inset -40px 0 40px -25px rgba(239, 68, 68, 0.4);
  animation: free-mode-pulse 2s ease-in-out infinite;
}

@keyframes free-mode-pulse {
  0%, 100% {
    box-shadow: 
      inset 40px 0 40px -25px rgba(239, 68, 68, 0.4),
      inset -40px 0 40px -25px rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 
      inset 50px 0 50px -30px rgba(239, 68, 68, 0.5),
      inset -50px 0 50px -30px rgba(239, 68, 68, 0.5);
  }
}

/* 新消息指示器 */
.new-message-indicator {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 150, 255, 0.4);
  transition: all 0.2s ease;
  animation: bounceIn 0.3s ease;
  z-index: 10;
  width: fit-content;
  margin: 0 auto;
}

.new-message-indicator:hover {
  background: var(--accent-primary-hover, #0080ff);
  transform: translateX(-50%) scale(1.05);
  box-shadow: 0 4px 16px rgba(0, 150, 255, 0.5);
}

.new-message-indicator:active {
  transform: translateX(-50%) scale(0.98);
}

@keyframes bounceIn {
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  100% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* 上下文使用量迷你指示器 */
.context-mini {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px; /* 扩大悬停区域 */
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

.context-mini-bar.cached {
  background: #2dd4bf;
}

.context-mini-bar.warning {
  background: var(--accent-warning, #f59e0b);
}

.context-mini-bar.danger {
  background: var(--accent-error, #ef4444);
}

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
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s ease;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.context-mini:hover .context-mini-tip {
  opacity: 1;
  visibility: visible;
}

/* 旧的上下文样式（保留兼容） */
.context-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  font-size: 11px;
}

.context-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.context-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.context-separator {
  opacity: 0.5;
}

.context-bar {
  width: 60px;
  height: 4px;
  background: var(--bg-surface);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 2px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-bar-fill.warning {
  background: var(--accent-warning, #f59e0b);
}

.context-bar-fill.danger {
  background: var(--accent-error, #ef4444);
}

.ai-welcome {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.ai-welcome .welcome-section-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 10px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-welcome .welcome-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

.ai-welcome ul {
  margin: 4px 0 6px;
  padding-left: 16px;
}

.ai-welcome li {
  margin: 2px 0;
  color: var(--text-muted);
  font-size: 11px;
}

.ai-welcome li strong {
  color: var(--accent-primary);
  font-weight: 500;
}

.strict-badge {
  display: inline-block;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 500;
  background: var(--accent-primary);
  color: #fff;
  border-radius: 4px;
  margin-left: 6px;
}

.strict-badge.relaxed {
  background: var(--accent-secondary, #10b981);
}

.strict-badge.free {
  background: #ef4444;
}

/* ==================== 历史对话列表样式 ==================== */

.recent-history-section {
  margin-top: 20px;
  padding: 16px;
  background: linear-gradient(135deg, var(--bg-tertiary) 0%, transparent 100%);
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
}

.recent-history-section .welcome-section-title {
  margin-bottom: 14px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.history-loading,
.history-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  background: var(--bg-surface);
  border-radius: 8px;
  border: 1px dashed var(--border-color);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.history-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent-primary);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.history-card:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--accent-primary) 30%, transparent);
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.history-card:hover::before {
  opacity: 1;
}

.history-card:active {
  transform: translateX(2px) scale(0.99);
}

.history-load-more {
  width: 100%;
  padding: 10px;
  margin-top: 4px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.history-load-more:hover:not(:disabled) {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.history-load-more:disabled {
  opacity: 0.5;
  cursor: default;
}

.history-status-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  transition: transform 0.2s ease;
}

.history-card:hover .history-status-icon {
  transform: scale(1.1);
}

.history-status-icon.completed {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(16, 185, 129, 0.1) 100%);
  color: #10b981;
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.3);
}

.history-status-icon.failed {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(239, 68, 68, 0.1) 100%);
  color: #ef4444;
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.3);
}

.history-status-icon.aborted {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(245, 158, 11, 0.1) 100%);
  color: #f59e0b;
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.3);
}

.history-task {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 450;
  letter-spacing: 0.1px;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.history-ssh {
  font-size: 10px;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.history-time {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.view-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.view-more-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.view-more-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-primary) 20%, transparent);
}

.view-more-btn:hover::before {
  opacity: 0.08;
}

.view-more-btn:active {
  transform: translateY(0);
}

/* 历史弹窗 */
.history-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  animation: modalOverlayIn 0.2s ease;
}

@keyframes modalOverlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.history-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
  animation: modalSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.history-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-surface) 0%, transparent 100%);
}

.history-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.2px;
}

.history-modal-close {
  background: var(--bg-hover);
  border: none;
  font-size: 18px;
  color: var(--text-secondary);
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.history-modal-close:hover {
  background: var(--accent-error);
  color: white;
}

.history-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.history-modal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-modal-list .history-card {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
}

.history-modal-list .history-card:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
}

.message {
  padding-bottom: 12px;
}

@keyframes messageEnter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.user {
  display: flex;
  justify-content: flex-end;
}

.message.assistant {
  display: flex;
  justify-content: flex-start;
}

.standalone-mode .message.assistant {
  align-items: flex-start;
}

.standalone-mode .message.assistant::before {
  content: '';
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  margin-right: 8px;
  margin-top: 2px;
  border-radius: 8px;
  background-image: var(--assistant-avatar);
  background-size: 68%;
  background-position: center;
  background-repeat: no-repeat;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  position: relative;
  z-index: 1;
}
.standalone-mode.custom-avatar .message.assistant::before {
  background-size: cover;
}

.message-wrapper {
  position: relative;
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.standalone-mode .message.assistant .message-wrapper {
  max-width: calc(85% - 42px);
}

.message.user .message-content {
  background: var(--accent-primary);
  color: var(--bg-primary);
  border-radius: 12px 12px 4px 12px;
  user-select: text;
  cursor: text;
}

.message.user .message-content :deep(a),
.message.user .message-content :deep(.file-path-link),
.message.user .message-content :deep(code.file-path-link) {
  color: inherit;
  text-decoration: underline;
  border-bottom: none;
}

.message.assistant .message-content {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 12px 12px 12px 4px;
  user-select: text;
  cursor: text;
}

.message-content {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  user-select: text;
  cursor: text;
  /* 限制重绘范围，减少布局抖动 */
  contain: layout style;
}

.message-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  user-select: text;
  cursor: text;
}

.markdown-content {
  width: 100%;
}

/* 代码块样式 */
/* 代码块样式 - 使用 :deep() 穿透 v-html */
.markdown-content :deep(.code-block) {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1b26;
  border: 1px solid rgba(255, 255, 255, 0.1);
  width: 100%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.markdown-content :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 500;
  color: #7aa2f7;
  background: #16161e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  text-transform: uppercase;
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

.markdown-content :deep(.code-actions) {
  display: flex;
  gap: 6px;
}

.markdown-content :deep(.code-copy-btn),
.markdown-content :deep(.code-send-btn) {
  padding: 4px 8px;
  font-size: 11px;
  color: #565f89;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

/* 确保 SVG 不拦截点击事件 */
.markdown-content :deep(.code-copy-btn svg),
.markdown-content :deep(.code-send-btn svg) {
  pointer-events: none;
}

.markdown-content :deep(.code-copy-btn:hover) {
  color: #7aa2f7;
  background: rgba(122, 162, 247, 0.15);
  border-color: #7aa2f7;
}

.markdown-content :deep(.code-send-btn:hover) {
  color: #9ece6a;
  background: rgba(158, 206, 106, 0.15);
  border-color: #9ece6a;
}

.markdown-content :deep(.code-block pre) {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  background: #1a1b26;
  white-space: pre;
}

.markdown-content :deep(.code-block code) {
  font-family: 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #a9b1d6;
  white-space: pre;
  display: block;
}

/* 行内代码样式 */
.markdown-content :deep(.inline-code) {
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: rgba(122, 162, 247, 0.15);
  border: 1px solid rgba(122, 162, 247, 0.3);
  border-radius: 4px;
  color: #7aa2f7;
}

/* Markdown 样式 - 使用 :deep() 穿透 v-html */
.markdown-content {
  line-height: 1.6;
  /* 开启 GPU 加速，减少流式输出时的重绘闪动 */
  transform: translateZ(0);
  backface-visibility: hidden;
}

.markdown-content :deep(p) {
  margin: 0 0 8px;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}

.markdown-content :deep(em) {
  font-style: italic;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2) {
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0 8px;
  color: var(--text-primary);
}

.markdown-content :deep(h3) {
  font-size: 14px;
  font-weight: 600;
  margin: 10px 0 6px;
  color: var(--text-primary);
}

.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 4px;
  color: var(--text-primary);
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-content :deep(li) {
  margin: 4px 0;
}

.markdown-content :deep(ul li) {
  list-style-type: disc;
}

.markdown-content :deep(ol li) {
  list-style-type: decimal;
}

.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-primary);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

/* 思考过程折叠区域样式 - 低调呈现 */
.markdown-content :deep(details) {
  margin: 4px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  overflow: hidden;
}

.markdown-content :deep(details[open]) {
  background: transparent;
}

.markdown-content :deep(summary) {
  padding: 2px 0;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.7;
  background: transparent;
  border-bottom: none;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: opacity 0.15s ease;
}

.markdown-content :deep(summary::-webkit-details-marker) {
  display: none;
}

.markdown-content :deep(summary::before) {
  content: '▶';
  font-size: 8px;
  transition: transform 0.2s ease;
  color: var(--text-muted);
  opacity: 0.7;
}

.markdown-content :deep(details[open] > summary::before) {
  transform: rotate(90deg);
}

.markdown-content :deep(summary:hover) {
  opacity: 1;
  background: transparent;
}

.markdown-content :deep(details > blockquote) {
  margin: 4px 0 4px 10px;
  padding: 6px 10px;
  border-left: 2px solid rgba(255, 255, 255, 0.08);
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
  opacity: 0.75;
}

/* 思考过程中的文本样式 */
.markdown-content :deep(details > blockquote p) {
  margin: 4px 0;
}

.markdown-content :deep(details > blockquote code) {
  background: rgba(0, 0, 0, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
}

.markdown-content :deep(a) {
  color: var(--accent-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

/* 可点击的文件路径链接 */
.markdown-content :deep(.file-path-link) {
  cursor: pointer;
  color: var(--accent-primary);
  text-decoration: none;
  transition: opacity 0.15s, background-color 0.15s;
}

.markdown-content :deep(.file-path-link:hover) {
  text-decoration: underline;
  opacity: 0.85;
}

/* 行内代码形式的文件路径（带底部虚线指示可点击） */
.markdown-content :deep(code.file-path-link) {
  cursor: pointer;
  color: var(--accent-primary);
  border-bottom: 1px dashed var(--accent-primary);
}

.markdown-content :deep(code.file-path-link:hover) {
  background: rgba(64, 158, 255, 0.12);
  text-decoration: none;
}

/* 普通 <a> 形式的文件路径链接（文本节点中检测到的裸路径） */
.markdown-content :deep(a.file-path-link) {
  cursor: pointer;
}

.markdown-content :deep(a.file-path-link::before) {
  content: '📄 ';
  font-size: 0.85em;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 12px 0;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--border-color);
  padding: 6px 10px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--bg-tertiary);
  font-weight: 600;
}

.copy-btn {
  align-self: flex-start;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--accent-primary);
}


@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* ==================== Agent 模式样式 ==================== */

/* Agent 设置区域 */
.agent-settings {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 超时设置 */
.timeout-setting {
  display: flex;
  align-items: center;
  gap: 4px;
}

.timeout-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.timeout-select {
  font-size: 11px;
  height: 26px;
  padding: 0 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  text-align: right;
}

.timeout-select:hover {
  border-color: var(--accent-primary);
}

.timeout-select:focus {
  border-color: var(--accent-primary);
}

/* 严格模式开关 */
.strict-mode-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.toggle-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.toggle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  background: var(--bg-tertiary);
  border-radius: 9px;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.toggle-switch.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch.active .toggle-dot {
  transform: translateX(14px);
}

/* 执行模式选择器 */
.execution-mode-selector {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  padding: 2px;
  border: 1px solid var(--border-color);
}

.mode-option {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mode-option:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.mode-option.active {
  background: var(--accent-primary);
  color: #fff;
}

.mode-option-free.active {
  background: #ef4444;
}

.mode-option-free:hover:not(.active) {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

/* 自由模式确认对话框 */
.free-mode-confirm-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.free-mode-confirm-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.confirm-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.confirm-dialog-icon {
  font-size: 24px;
}

.confirm-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #ef4444;
}

.confirm-dialog-content {
  margin-bottom: 20px;
}

.confirm-dialog-content p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.confirm-dialog-warnings {
  margin: 12px 0;
  padding-left: 20px;
}

.confirm-dialog-warnings li {
  font-size: 12px;
  color: #ef4444;
  margin: 6px 0;
  line-height: 1.4;
}

.confirm-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.btn-outline:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* 警告文本样式 */
.warning-text {
  color: #ef4444 !important;
}

/* Agent 步骤（融入对话） */
.agent-steps-wrapper {
  max-width: 95% !important;
}

.agent-steps-content {
  padding: 12px 14px !important;
}

.agent-steps-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
}

.agent-steps-header-inline:hover {
  opacity: 0.8;
}

.steps-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: auto;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.agent-steps-body {
  margin-top: 10px;
}


/* AI 思考中指示器（高度与 .agent-step-inline 一致，避免切换抖动） */
.agent-thinking-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}

.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(52, 211, 153, 0.2);
  border-top-color: #34d399;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.3);
}

.thinking-text {
  font-size: 13px;
  /* 渐变文字动画 */
  background: linear-gradient(
    90deg,
    rgba(110, 231, 183, 0.75) 0%,
    rgba(52, 211, 153, 1) 50%,
    rgba(110, 231, 183, 0.75) 100%
  );
  background-size: 200% 100%;
  animation: gradient-flow 2s linear infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  color: rgba(110, 231, 183, 0.75);
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Agent 最终回复 - 美化样式 */
.message.assistant:has(.agent-final-wrapper) {
  padding-top: 8px;
}

.agent-final-wrapper {
  background: transparent !important;
}

.message.assistant .agent-final-content {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.agent-final-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(16, 185, 129, 0.1);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 13px;
  font-weight: 500;
}

/* 失败状态的样式 */
.agent-final-content.is-error .agent-final-header {
  background: rgba(244, 67, 54, 0.1);
}

.agent-final-content.is-error {
  border-color: rgba(244, 67, 54, 0.2);
}

.agent-final-content.is-aborted .agent-final-header {
  background: rgba(255, 152, 0, 0.1);
}

.agent-final-content.is-aborted {
  border-color: rgba(255, 152, 0, 0.2);
}

.final-icon {
  font-size: 16px;
}

.final-title {
  color: var(--text-primary);
}

.agent-final-body {
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.agent-final-body :deep(p) {
  margin: 4px 0;
}

.agent-final-body :deep(p:first-child) {
  margin-top: 0;
}

.agent-final-body :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-final-body :deep(strong) {
  color: var(--accent-primary);
}

.agent-final-body :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid #10b981;
  background: rgba(16, 185, 129, 0.08);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.agent-final-body :deep(blockquote p) {
  margin: 0;
}

.agent-final-body :deep(ul),
.agent-final-body :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.agent-final-body :deep(li) {
  margin: 4px 0;
}

.agent-final-body :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.agent-final-body :deep(pre) {
  margin: 8px 0;
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  overflow-x: auto;
}

.agent-final-body :deep(pre code) {
  background: transparent;
  padding: 0;
}

.agent-running-dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* Agent 步骤消息（紧凑显示） */
.agent-step-message {
  margin-bottom: 4px !important;
}

.agent-step-message .message-wrapper {
  padding: 6px 0;
}

.agent-step-content-inline {
  display: flex;
  gap: 8px;
  padding: 8px 12px !important;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.agent-step-inline {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.agent-step-inline:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.step-content {
  flex: 1;
  min-width: 0;
  /* 限制重绘范围，减少流式输出时的布局抖动 */
  contain: layout style;
}

.step-text {
  word-break: break-word;
  line-height: 1.5;
}

/* AI 分析文本样式 */
.step-text.step-analysis {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 10px;
  border-radius: 6px;
  margin: -4px 0;
}

/* Agent 步骤中的 markdown 样式 */
.step-text.step-analysis.markdown-content {
  font-size: 13px;
}

/* 流式输出时的样式优化 */
.step-text.step-analysis.markdown-content.is-streaming {
  /* 不设置固定最小高度，让内容自然撑开，从单行开始按需增长 */
  min-height: auto;
  /* 提示浏览器内容会变化 */
  will-change: contents;
}

.step-text.step-analysis.markdown-content :deep(p) {
  margin: 4px 0;
}

.step-text.step-analysis.markdown-content :deep(strong) {
  color: var(--accent-primary);
}

/* 思考过程引用块样式 */
.step-text.step-analysis.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid #7aa2f7;
  background: rgba(122, 162, 247, 0.1);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  max-height: 300px;
  overflow-y: auto;
}

.step-text.step-analysis.markdown-content :deep(blockquote p) {
  margin: 0;
}

.step-text.step-analysis.markdown-content :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.step-result {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  max-height: 120px;
  overflow-y: auto;
}

.step-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
}

.step-images {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.step-image {
  max-width: 200px;
  max-height: 150px;
  border-radius: 6px;
  cursor: pointer;
  object-fit: contain;
  transition: transform 0.15s, box-shadow 0.15s;
}

.step-image:hover {
  transform: scale(1.03);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.agent-step-inline.thinking {
  color: rgba(110, 231, 183, 0.75);
}

.agent-step-inline.thinking .step-icon {
  animation: pulse 1.5s ease-in-out infinite;
}

.agent-step-inline.thinking .step-text {
  animation: pulse-text 2s ease-in-out infinite;
}

.agent-step-inline.tool_call {
  color: var(--accent-primary);
}

.agent-step-inline.tool_call .step-text {
  color: var(--text-primary);
}

.agent-step-inline.error {
  color: var(--accent-error, #f44336);
}

.agent-step-inline.message {
  color: var(--text-primary);
}

/* 用户补充消息：样式类似用户消息气泡，但略有区分 */
.agent-step-inline.user_supplement {
  display: flex;
  justify-content: flex-end;
  background: transparent;
  border-left: none;
  padding-left: 0;
  margin-left: 0;
}

.agent-step-inline.user_supplement .step-content {
  background: var(--accent-primary);
  opacity: 0.85;
  color: var(--bg-primary);
  border-radius: 12px 12px 4px 12px;
  padding: 8px 12px;
  max-width: 80%;
}

.agent-step-inline.user_supplement .step-icon {
  display: none;
}

.agent-step-inline.user_supplement .step-content :deep(a),
.agent-step-inline.user_supplement .step-content :deep(.file-path-link),
.agent-step-inline.user_supplement .step-content :deep(code.file-path-link) {
  color: inherit;
  text-decoration: underline;
  border-bottom: none;
}

.agent-step-inline.waiting {
  background: rgba(59, 130, 246, 0.1);
  border-left: 3px solid #3b82f6;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.waiting .step-icon {
  color: #3b82f6;
}

.agent-step-inline.asking {
  background: rgba(96, 165, 250, 0.08);
  border-left: 3px solid #60a5fa;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.asking .step-icon {
  color: #60a5fa;
}

.agent-step-inline.waiting_password {
  background: rgba(251, 191, 36, 0.12);
  border-left: 3px solid #fbbf24;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
  animation: password-pulse 2s ease-in-out infinite;
}

.agent-step-inline.waiting_password .step-icon {
  color: #fbbf24;
  animation: key-bounce 1s ease-in-out infinite;
}

@keyframes password-pulse {
  0%, 100% { 
    background: rgba(251, 191, 36, 0.12);
    border-left-color: #fbbf24;
  }
  50% { 
    background: rgba(251, 191, 36, 0.2);
    border-left-color: #f59e0b;
  }
}

@keyframes key-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

/* 提问内容样式 */
.asking-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.asking-question {
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-primary);
}

.asking-default {
  font-size: 11px;
  color: var(--text-muted);
}

.asking-default .default-label {
  font-style: italic;
}

.asking-default .default-hint {
  color: #10b981;
  margin-left: 6px;
}

.asking-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  max-width: 400px;
}

.asking-option-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  background: rgba(96, 165, 250, 0.06);
  border: 1px solid rgba(96, 165, 250, 0.2);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.asking-option-btn .option-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.asking-option-btn:hover:not(:disabled) {
  background: rgba(96, 165, 250, 0.12);
  border-color: rgba(96, 165, 250, 0.35);
}

.asking-option-btn:active:not(:disabled) {
  background: rgba(96, 165, 250, 0.18);
}

.asking-option-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-option-btn.clicking {
  background: rgba(96, 165, 250, 0.2);
  border-color: rgba(96, 165, 250, 0.5);
  color: #60a5fa;
}

.asking-option-btn.clicking .option-label {
  background: rgba(96, 165, 250, 0.3);
  color: #60a5fa;
}

.asking-option-btn.selected {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.35);
  color: #22c55e;
}

.asking-option-btn.selected .option-label {
  background: rgba(34, 197, 94, 0.25);
  color: #22c55e;
}

/* 多选确认按钮 */
.asking-confirm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.asking-confirm-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #93c5fd 0%, #60a5fa 100%);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35);
}

.asking-confirm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-status {
  font-size: 11px;
  margin-top: 2px;
}

.asking-status.status-waiting {
  color: var(--text-muted);
}

.asking-status.status-done {
  color: #22c55e;
}

.asking-status.status-timeout {
  color: #f59e0b;
}

.asking-status.status-cancelled {
  color: #ef4444;
}

/* 计划步骤样式 */
.plan-step-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  margin: -4px -8px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.plan-step-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.plan-step-text {
  flex: 1;
  color: var(--text-primary);
}

.plan-expand-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.plan-expand-icon.expanded {
  transform: rotate(90deg);
}

.plan-step-details {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

/* 归档计划的特殊样式 */
.agent-step-inline.plan_archived .plan-step-text {
  color: var(--text-muted);
}

.agent-step-inline.plan_archived .plan-step-header:hover .plan-step-text {
  color: var(--text-primary);
}

/* ==================== 并行子 Agent 卡片组 ==================== */

.sub-agents-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding: 6px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.sub-agent-card {
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.sub-agent-card.running {
  border-color: rgba(59, 130, 246, 0.4);
}

.sub-agent-card.completed {
  border-color: rgba(110, 231, 183, 0.3);
}

.sub-agent-card.failed {
  border-color: rgba(244, 67, 54, 0.3);
}

.sub-agent-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
}

.sub-agent-header .sub-agent-status-icon,
.sub-agent-header .sub-agent-status-text,
.sub-agent-header .sub-agent-expand-icon {
  margin-top: 1px;
}

.sub-agent-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sub-agent-status-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
}

.sa-icon-pending {
  color: var(--text-muted);
}

.sa-icon-running {
  color: #3b82f6;
  animation: sa-spin 1.2s linear infinite;
}

.sa-icon-completed {
  color: #6ee7b7;
}

.sa-icon-failed {
  color: #f44336;
}

@keyframes sa-spin {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.sub-agent-header-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.sub-agent-desc {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-agent-activity {
  font-size: 11px;
  color: #3b82f6;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: sa-spin 1.5s ease-in-out infinite;
}

.sub-agent-status-text {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.sub-agent-card.running .sub-agent-status-text {
  color: #3b82f6;
}

.sub-agent-card.completed .sub-agent-status-text {
  color: #6ee7b7;
}

.sub-agent-card.failed .sub-agent-status-text {
  color: #f44336;
}

.sub-agent-expand-icon {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.sub-agent-expand-icon.expanded {
  transform: rotate(90deg);
}

.sub-agent-detail {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.1);
}

.sub-agent-prompt {
  padding: 6px 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-steps {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sa-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.sa-step-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 10px;
}

.sa-step-running { color: #3b82f6; }
.sa-step-done { color: #6ee7b7; }
.sa-step-fail { color: #f44336; }

.sa-step-tool {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.sa-step-args {
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.sub-agent-result {
  padding: 6px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-result pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.sub-agent-result pre.sub-agent-error {
  color: #f44336;
}



/* 风险等级颜色 */
.risk-safe {
  border-left: 3px solid #10b981;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-moderate {
  border-left: 3px solid #f59e0b;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-dangerous {
  border-left: 3px solid #ef4444;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-blocked {
  border-left: 3px solid #6b7280;
  padding-left: 10px;
}

/* 拒绝执行的步骤 */
.step-rejected {
  opacity: 0.6;
  border-left: 3px solid #ef4444 !important;
  padding-left: 10px;
  margin-left: -2px;
  opacity: 0.6;
}

/* Agent 确认对话框（融入对话） */
.agent-confirm-inline {
  padding: 14px;
  border-radius: 10px;
}

/* ===== 高风险 - 红色系 ===== */
.agent-confirm-inline.risk-dangerous {
  background: linear-gradient(135deg, #3b1018 0%, #2a0a10 100%) !important;
  border: 2px solid #ef4444 !important;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.2);
}

/* ===== 中风险 - 橙黄色系 ===== */
.agent-confirm-inline.risk-moderate {
  background: linear-gradient(135deg, #3d2f10 0%, #2a2008 100%) !important;
  border: 2px solid #f59e0b !important;
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.15);
}

/* ===== 低风险 - 绿色系 ===== */
.agent-confirm-inline.risk-safe {
  background: linear-gradient(135deg, #0f2920 0%, #081a14 100%) !important;
  border: 2px solid #10b981 !important;
  box-shadow: 0 4px 20px rgba(16, 185, 129, 0.1);
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.confirm-icon {
  font-size: 20px;
}

.confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.confirm-risk-badge {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 4px;
  margin-left: auto;
}

.confirm-risk-badge.risk-dangerous {
  background: #ef4444;
  color: #fff;
}

.confirm-risk-badge.risk-moderate {
  background: #f59e0b;
  color: #000;
}

.confirm-risk-badge.risk-safe {
  background: #10b981;
  color: #fff;
}

.confirm-detail {
  margin-bottom: 12px;
}

.confirm-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
}

.confirm-args-inline {
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  margin: 0;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: #fff;
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline-secondary {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: rgba(255, 255, 255, 0.8);
}

.btn-outline-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.btn-warning {
  background: #f59e0b;
  border: 1px solid #f59e0b;
  color: #000;
}

.btn-warning:hover:not(:disabled) {
  background: #d97706;
  border-color: #d97706;
}

.btn-danger {
  background: #ef4444;
  border: 1px solid #ef4444;
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: #dc2626;
  border-color: #dc2626;
}

/* 成功按钮样式 */
.btn-success {
  background: #10b981;
  border-color: #10b981;
  color: #fff;
}

.btn-success:hover:not(:disabled) {
  background: #059669;
  border-color: #059669;
}

/* Outline 按钮样式（用于"始终允许"） */
.btn-outline-warning {
  background: transparent;
  border: 1px solid #f59e0b;
  color: #f59e0b;
}

.btn-outline-warning:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}

.btn-outline-success {
  background: transparent;
  border: 1px solid #10b981;
  color: #10b981;
}

.btn-outline-success:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

/* ==================== @ 命令补全菜单样式 ==================== */

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
  animation: mentionMenuSlideUp 0.15s ease-out;
}

@keyframes mentionMenuSlideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  /* 从右到左显示，让省略号在左边，优先显示路径最后部分 */
  direction: rtl;
  text-align: right;
}

.mention-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(100, 150, 255, 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.mention-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
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

/* ==================== 图片上传预览条 ==================== */
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

/* ==================== 聊天中的图片消息 ==================== */
.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.message-image {
  max-width: 200px;
  max-height: 150px;
  border-radius: 8px;
  object-fit: cover;
  cursor: pointer;
  border: 1px solid var(--border-color);
  transition: transform 0.15s, box-shadow 0.15s;
}

.image-preview-hint {
  font-size: 11px;
  color: inherit;
  margin-top: 4px;
  opacity: 0.7;
}

.message-image:hover {
  transform: scale(1.02);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
}

/* ==================== 聊天中的文件附件 ==================== */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid currentColor;
  opacity: 0.7;
  font-size: 11px;
  line-height: 1.4;
}

.attachment-name {
  word-break: break-all;
}

.attachment-size {
  opacity: 0.8;
  flex-shrink: 0;
  white-space: nowrap;
}

/* ==================== 图片预览弹窗（支持缩放拖拽） ==================== */
.image-preview-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease;
  cursor: default;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.image-preview-modal-content {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  overflow: visible;
}

.image-preview-full {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
  cursor: grab;
  transform-origin: center center;
  transition: none;
  user-select: none;
  -webkit-user-drag: none;
}

.image-preview-full.dragging {
  cursor: grabbing;
}

.image-preview-close {
  position: absolute;
  top: -12px;
  right: -12px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
  z-index: 1;
}

.image-preview-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* 底部信息栏 */
.image-preview-info-bar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}

.image-preview-counter,
.image-preview-zoom-badge {
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(4px);
  white-space: nowrap;
}

/* 导航箭头按钮 */
.image-preview-nav {
  position: fixed;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  z-index: 10001;
  backdrop-filter: blur(4px);
}

.image-preview-nav:hover {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.nav-left {
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
}

.nav-right {
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
}

.nav-up {
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
}

.nav-down {
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
}

</style>
