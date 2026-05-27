<script setup lang="ts">
/**
 * AI 面板组件
 * 重构版本：使用 composables 模块化管理逻辑
 * 每个 tab 独立实例，通过 tabId prop 绑定
 */
import { ref, reactive, computed, watch, inject, onMounted, onUnmounted, toRef, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, Trash2, X, Search, Loader2, HelpCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, MoreHorizontal, Shuffle } from 'lucide-vue-next'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { useComposerQuoteStore } from '../stores/composer-quote'
import AgentPlanView from './AgentPlanView.vue'
import AiComposer from './AiComposer.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallContent from './ToolCallContent.vue'
import ImageContextMenu from './ImageContextMenu.vue'
import EChartsCanvas from './EChartsCanvas.vue'
import { useImageActions } from '../composables/useImageActions'
import { parseThinking } from '../utils/thinking-block'
import { createLogger } from '../utils/logger'
import sailfishLogo from '../../resources/logo.png'

const log = createLogger('AiPanel')

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
import { showConfirm } from '../composables/useConfirm'
import { planComposerPaste, ingestComposerAttachments } from '../composables/useComposerPaste'
import {
  getFeaturedExamples,
  shuffleExamples as shuffleExamplePool,
  type AssistantExample,
} from '../config/assistantExamples'
import type { AgentRecord, AgentHistorySummary } from '@shared/types'

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
const composerQuoteStore = useComposerQuoteStore()
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

// ==================== 独立助手能力示例网格 ====================
// 欢迎区展示的 8 张场景卡片。首屏精选覆盖最广能力组合，"换一批"从 25 条池子洗牌。
// 仅独立助手 tab 使用，因此普通终端 tab 上 displayedExamples 不会被读取，开销可忽略。
const displayedExamples = ref<AssistantExample[]>(getFeaturedExamples())
const shuffleSpinning = ref(false)
const shuffleScenarios = () => {
  // 排除当前展示的 ID，避免连点两次出现完全相同的卡片
  const currentIds = displayedExamples.value.map(e => e.id)
  displayedExamples.value = shuffleExamplePool(currentIds)
  // 给按钮一次旋转动画，仅视觉反馈
  shuffleSpinning.value = false
  nextTick(() => {
    shuffleSpinning.value = true
    setTimeout(() => { shuffleSpinning.value = false }, 600)
  })
}
const handleScenarioClick = (example: AssistantExample) => {
  const prompt = t(`ai.agentWelcome.scenarios.${example.id}.prompt`)
  composerRef.value?.setText(prompt)
  composerRef.value?.flashHint()
}

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
    await ingestAttachmentFiles(input.files)
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

// Web 搜索结果展开状态（默认收起，用户点击展开后可见全部链接）
const expandedWebSearchSteps = ref<Set<string>>(new Set())
const toggleWebSearchExpand = (stepId: string) => {
  if (expandedWebSearchSteps.value.has(stepId)) {
    expandedWebSearchSteps.value.delete(stepId)
  } else {
    expandedWebSearchSteps.value.add(stepId)
  }
}

// 思考块展开状态（默认收起，按 stepId 管理；让 DynamicScroller 的 size dep 能感知切换）
const expandedThinkingSteps = ref<Set<string>>(new Set())
const isThinkingExpanded = (stepId: string): boolean => {
  return expandedThinkingSteps.value.has(stepId)
}
const toggleThinkingExpand = (stepId: string) => {
  if (expandedThinkingSteps.value.has(stepId)) {
    expandedThinkingSteps.value.delete(stepId)
  } else {
    expandedThinkingSteps.value.add(stepId)
  }
}

// 任务完成尾注的显示条件：group 完成（finalResult 存在且非失败/中断）+ 当前是 group 内最后一个
// 可见的 message step。把"✓ 任务完成"作为最后一个 message step 的内部尾巴渲染，避免单独成 item
// 引起列表重排跳动。
const shouldShowTaskCompleteFooter = (item: { step?: { id: string; type: string }; group?: { finalResult?: string; steps: Array<{ id: string; type: string }> } }): boolean => {
  if (!item.step || !item.group) return false
  const finalResult = item.group.finalResult
  if (!finalResult) return false
  // 失败/中断有独立卡片显示错误信息，不在 message step 上重复尾注
  if (finalResult.startsWith('❌') || finalResult.startsWith('⚠️')) return false
  // 仅在 group 内最后一个 message step 上显示尾注
  const messageSteps = item.group.steps.filter(s => s.type === 'message')
  if (messageSteps.length === 0) return false
  return messageSteps[messageSteps.length - 1].id === item.step.id
}

// 任务完成尾注首次出现时给一次性 fade-in 动画。
//
// 问题：footer 是 `v-if` 控制，且外层用 DynamicScroller 虚拟滚动，footer 滚出
// 视区后会被 unmount，滚回时 remount——如果 CSS 入场动画无条件挂在 .agent-final-footer
// 上，每次 remount 都会重播，造成"翻历史一路滑入闪烁"。
//
// 方案：用 Set 记录"已经播过入场动画的 group id"，class 只在 Set 不包含该 group 时
// 附加 → 第一次出现时播动画 → animationend 写入 Set → 之后无论怎么 remount 都不再
// 附加 class 也就不再播放。
const animatedFooters = new Set<string>()

const isFooterFirstShow = (groupId: string | undefined): boolean => {
  if (!groupId) return false
  return !animatedFooters.has(groupId)
}

const markFooterAnimated = (groupId: string | undefined) => {
  if (groupId) animatedFooters.add(groupId)
}

/**
 * group 操作菜单（含「另开一聊」）的可见性条件：
 *   - group 已完成（成功 / 失败 / 中断都允许）
 *   - 非 proactive / 非 onboarding（这两类不是用户发起的真实对话）
 *   - Agent 不在运行中（运行中状态不一致，不允许 fork）
 *   - 当前 tab 不是「加载历史」状态：加载历史时后端 Agent in-memory 没有会话数据，
 *     fork 必然失败；且 LLM provider 的 prompt cache 也大概率早已过期（5 分钟 TTL），
 *     即便绕路从 HistoryService 拉取也无性能收益。直接不显示菜单更诚实
 */
const isLoadedFromHistory = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
  return !!tab?.agentState?.loadedFromHistory
})

const canShowGroupMenu = (group: import('../composables').AgentTaskGroup | undefined): boolean => {
  if (!group) return false
  if (!group.finalResult) return false
  if (group.isProactive || group.isOnboarding) return false
  if (isAgentRunning.value) return false
  if (isLoadedFromHistory.value) return false
  return true
}

// 正在 fork 的 group ID 集合：防止用户连续点击同一个按钮创建多个 fork tab
const forkingGroupIds = ref<Set<string>>(new Set())

// 当前展开操作菜单的 group ID（同一时间最多一个菜单展开）
// 菜单通过 Teleport 渲染到 body，避免被 vue-virtual-scroller 的 overflow:hidden 裁掉
const openGroupMenuId = ref<string | null>(null)
const groupMenuPosition = ref<{ top: number; right: number }>({ top: 0, right: 0 })

const toggleGroupMenu = (group: import('../composables').AgentTaskGroup | undefined, event: MouseEvent) => {
  if (!group) return
  if (openGroupMenuId.value === group.id) {
    openGroupMenuId.value = null
    return
  }
  // 以触发按钮的右下角对齐菜单（top = 按钮底部 + 4px gap，right = 视窗右边缘 - 按钮右边缘）
  const trigger = event.currentTarget as HTMLElement
  const rect = trigger.getBoundingClientRect()
  groupMenuPosition.value = {
    top: rect.bottom + 4,
    right: window.innerWidth - rect.right
  }
  openGroupMenuId.value = group.id
}

// 当前展开菜单对应的 group 引用（Teleport 菜单按钮的 onClick 用它）
const openGroupMenuGroup = computed(() =>
  agentTaskGroups.value.find(g => g.id === openGroupMenuId.value)
)

const handleForkFromGroup = async (group: import('../composables').AgentTaskGroup | undefined) => {
  if (!group) return
  if (!canShowGroupMenu(group)) return
  if (forkingGroupIds.value.has(group.id)) return
  openGroupMenuId.value = null
  forkingGroupIds.value.add(group.id)
  try {
    const newTabId = await terminalStore.forkToAssistantTab(currentTabId.value, {
      untilTaskCount: group.index + 1
    })
    if (!newTabId) {
      log.warn('Fork from group failed', { groupId: group.id, untilTaskCount: group.index + 1 })
      window.alert(t('ai.fork.failed'))
    }
  } finally {
    forkingGroupIds.value.delete(group.id)
  }
}

const closeGroupMenu = () => {
  if (openGroupMenuId.value !== null) openGroupMenuId.value = null
}

// 点击其他地方关闭菜单
const handleGlobalClickForGroupMenu = (e: MouseEvent) => {
  if (openGroupMenuId.value === null) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.agent-group-menu') || target?.closest('.agent-group-menu-trigger')) return
  openGroupMenuId.value = null
}

// 滚动 / 窗口尺寸变化时关闭菜单：fixed 定位的菜单不会跟随滚动，留在原位会与触发按钮失去视觉关联
const handleScrollForGroupMenu = () => closeGroupMenu()

onMounted(() => {
  document.addEventListener('mousedown', handleGlobalClickForGroupMenu)
  window.addEventListener('resize', closeGroupMenu)
  // 监听虚拟滚动容器的 scroll 事件（capture 阶段，覆盖各种内部滚动场景）
  document.addEventListener('scroll', handleScrollForGroupMenu, true)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', handleGlobalClickForGroupMenu)
  window.removeEventListener('resize', closeGroupMenu)
  document.removeEventListener('scroll', handleScrollForGroupMenu, true)
})

// 识别 createRun 一开始插入的"正在准备..." 占位步骤（type='thinking' + isStreaming=true）。
// 让它借用 message step 的视觉壳（同一图标 + 同一 wrapper + ThinkingBlock 流式态），
// 切换到真正的 message step 时外观无差，达到"持续往下呼呼输出"的稳定感。
// 其它 thinking step（如截断警告、参数错误）isStreaming 为 undefined，不会被误判。
const isInitialPreparingStep = (step: { type: string; isStreaming?: boolean }): boolean => {
  return step.type === 'thinking' && step.isStreaming === true
}

// 思考块完成时长缓存（按 stepId 索引）
// DynamicScroller 是虚拟列表，已完成的 ThinkingBlock 滚出视区后会被 unmount、滚回时 remount，
// 仅用 step.timestamp 重算会得到"从起点到现在"的错乱时长（变成几十~上百秒）。
// 此处用一个会话内的内存 Map 缓存：组件首次完成时 emit finalize 上报真实时长，remount 时回传，使用 reactive ref 触发模板更新
const thinkingDurations = ref<Map<string, number>>(new Map())
const getCachedThinkingDuration = (stepId: string): number | undefined => {
  return thinkingDurations.value.get(stepId)
}
const cacheThinkingDuration = (stepId: string, ms: number) => {
  // 同一 step 重复上报时仅在尚未缓存时写入，避免覆盖第一次的真实时长
  if (!thinkingDurations.value.has(stepId)) {
    const next = new Map(thinkingDurations.value)
    next.set(stepId, ms)
    thinkingDurations.value = next
  }
}

// 在默认浏览器中打开 URL（仅允许 http/https，防范 javascript:/data: 等协议）
const openWebSearchLink = (url: string) => {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[AiPanel] Blocked non-http(s) URL:', url)
      return
    }
    window.open(parsed.href, '_blank', 'noopener,noreferrer')
  } catch (e) {
    console.warn('[AiPanel] Invalid URL:', url, e)
  }
}

// 获取 URL 的主机名用于展示
const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
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
  parsingDocs,
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
  handleDroppedImages,
  removeImage,
  clearImages,
  getImageDataUrls,
  hasImages
} = useImageUpload()

const hasImagesComputed = computed(() => hasImages())

/** 附件分流：图片 → 视觉区，其余 → 文档解析（粘贴 / 拖放 / 选择附件共用） */
const ingestAttachmentFiles = (files: FileList | File[]) =>
  ingestComposerAttachments(files, {
    ingestImages: handleDroppedImages,
    ingestDocuments: handleDroppedFiles
  })

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
  getExecStatusClass,
  // 历史对话功能
  recentHistory,
  isLoadingHistory,
  showHistoryModal,
  allHistory,
  isLoadingAllHistory,
  isHistorySearchLoading,
  historyFullTextSearchActive,
  historySearchTotalMatched,
  hasMoreHistory,
  historySearchKeyword,
  setHistorySearchKeyword,
  flushHistorySearch,
  clearHistorySearch,
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
  },
  scrollerRef
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

  // 如果按下的不是 PTT 键，且当前正在 PTT 状态（计时器或录音中），则中止 PTT
  if (event.key !== pttKey) {
    if (isPushToTalk.value || pttStartTimer || isRecording.value) {
      clearPTTStartTimer()
      clearPTTStopTimer()
      isPushToTalk.value = false
      cancelRecording()
    }
    return
  }

  // 以下是按下 PTT 键的处理逻辑
  if (event.repeat) return
  // 组合键（如 Ctrl+O）：PTT 为普通键时也必须忽略，否则仅 MODIFIER_KEYS.has(pttKey) 时才会走 hasOtherModifiers
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

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 历史弹窗列表：截断后高亮关键字（先 escape 再包 mark，避免 XSS） */
const highlightHistoryTaskHtml = (text: string, keyword: string, maxLen: number): string => {
  const truncated = truncateText(text, maxLen)
  const kw = keyword.trim()
  if (!kw) return escapeHtml(truncated)
  const escaped = escapeHtml(truncated)
  const safeKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return escaped.replace(
      new RegExp(safeKw, 'gi'),
      m => `<mark class="history-search-mark">${escapeHtml(m)}</mark>`
    )
  } catch {
    return escaped
  }
}

const historySearchInputRef = ref<HTMLInputElement | null>(null)
watch(
  () => showHistoryModal.value,
  async open => {
    if (open) {
      await nextTick()
      historySearchInputRef.value?.focus()
    }
  }
)

// 加载历史记录（带确认）。欢迎区为完整 AgentRecord；弹窗无 steps 时按 id 拉全量
const handleLoadHistory = async (row: AgentRecord | AgentHistorySummary) => {
  if (agentUserTask.value && hasExistingConversation.value) {
    if (!window.confirm(t('ai.agentWelcome.confirmLoadHistory'))) {
      return
    }
  }
  const record: AgentRecord | undefined =
    'steps' in row && Array.isArray(row.steps)
      ? (row as AgentRecord)
      : ((await window.electronAPI.history.getAgentRecordById(row.id)) as AgentRecord | undefined)
  if (!record) {
    toast.error(t('ai.agentWelcome.historyRecordMissing'))
    return
  }
  await loadHistoryRecord(record)
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

/**
 * 在发送前对"带图但当前模型不支持视觉"做硬拦截。
 * 返回 true 表示用户选择继续发送（带图字段会被后端剥掉），false 表示用户取消，调用方应中止发送。
 *
 * 提供三个动作：
 * - 取消（默认）：什么都不做
 * - 打开 AI 设置：跳到设置页让用户切换/关联视觉模型
 * - 仍然发送：继续走 runAgent，后端会自动剥图并注入提示，让 AI 主动告知用户「我没看到图」
 */
const guardVisionBeforeSend = async (): Promise<boolean> => {
  if (!hasImages()) return true
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (hasVision) return true

  const profile = activeAiProfile.value
  const proceed = await showConfirm({
    type: 'warning',
    title: t('ai.visionGuardTitle'),
    message: t('ai.visionGuardMessage', { model: profile?.model || t('ai.visionGuardCurrentModel') }),
    detail: t('ai.visionGuardDetail'),
    confirmText: t('ai.visionGuardSendAnyway'),
    cancelText: t('common.cancel'),
    neutralText: t('ai.visionGuardOpenSettings'),
    onNeutral: () => {
      showSettings?.()
    }
  })
  // 用户确认"仍然发送"——按钮文案承诺了"不带图"，所以这里立刻清掉 pendingImages，
  // 避免几 MB 的 base64 仍走渲染→主进程 IPC（后端虽然会兜底剥图，但传输已经发生了）。
  if (proceed) {
    clearImages()
    toast.info(t('ai.visionGuardImagesDropped'))
  }
  return proceed
}

// 粘贴：文本优先（有纯文本则默认贴字）；纯图/纯文件才拦截并走附件管道
const handlePaste = async (event: ClipboardEvent) => {
  const plan = planComposerPaste(event)
  if (plan.kind === 'default') return
  event.preventDefault()
  await ingestAttachmentFiles(plan.files)
}

const clearTabError = () => {
  if (currentTabId.value) {
    terminalStore.clearError(currentTabId.value)
  }
}

const handleComposerSubmit = async (message: string) => {
  if (!(await guardVisionBeforeSend())) return
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

/** 终端右键「发送到 AI」：加入引用胶囊（发送时再附带全文与行号），不自动跑 Agent */
function addQuotedTerminalSelection(text: string, tabTitle: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const label = tabTitle.trim() || t('ai.quoteSnippetTerminalTabFallback')
  composerQuoteStore.addSnippet(props.tabId, {
    label,
    sourcePath: null,
    sourceLinesAccurate: false,
    quoteOrigin: 'terminal',
    startLine: null,
    endLine: null,
    excerpt: trimmed
  })
  toast.success(t('ai.quoteSnippetAdded'))
  nextTick(() => composerRef.value?.focusInput())
}

/** @deprecated 请使用 addQuotedTerminalSelection；保留别名兼容旧调用 */
function analyzeText(text: string) {
  const tab = terminalStore.tabs.find((x) => x.id === props.tabId)
  addQuotedTerminalSelection(text, tab?.title ?? '')
}

defineExpose({ analyzeText, addQuotedTerminalSelection })

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

// 诞生引导：全局仅自动触发一次（独立助手 tab）；用户跳过未完成 personality 也不再重复
let onboardingTriggered = false
watch(
  [
    isMounted,
    () => configStore.agentOnboardingShown,
    () => configStore.agentOnboardingCompleted,
    isStandaloneAssistant,
  ],
  async ([mounted, shown, completed, isAssistant]) => {
    if (!mounted || shown || completed || !isAssistant || onboardingTriggered) return
    if (!configStore.hasAiConfig) return
    onboardingTriggered = true
    await configStore.markAgentOnboardingShown()
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
  clearImages()
  void runAgent(`${t('ai.analyzeErrorPrompt')}\n\`\`\`\n${error.content}\n\`\`\``)
}

// 分析选中内容（通过 Agent 执行）
const handleAnalyzeSelection = () => {
  const selection = terminalSelectedText.value
  if (!selection || isLoading.value) return
  
  // 设置输入文本为分析提示
  // 通过 Agent 执行分析
  clearComposerDraft()
  clearImages()
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
// 活图预览载荷：当点击"活图"（chart skill 投递的 echartsOption）时填入；
// 模态优先用 EChartsCanvas 渲染（保留 tooltip / dataZoom 等交互），否则降级到 <img>。
// 上下/左右导航触发时清空（导航目标可能是普通 SVG 图），让降级路径自然接管。
const previewEchartsPayload = ref<import('@shared/types').EChartsStepPayload | null>(null)
// 视口尺寸——给活图预览容器算"contain 进 90vw × 90vh 框"的具体 width/height。
// 不能纯靠 CSS（max-width/max-height + aspect-ratio）：父容器 .image-preview-modal-content
// 是 max-content sizing，子元素 EChartsCanvas 又要 width:100%——两边互相依赖塌陷为 0×0。
const winSize = ref({ w: 1024, h: 768 })
function updateWinSize() {
  if (typeof window !== 'undefined') {
    winSize.value = { w: window.innerWidth, h: window.innerHeight }
  }
}
// 大图预览的 EChartsCanvas 实例 ref——复制图片 / 另存为时通过 getDataURL() 拿当前
// (含用户交互后的 dataZoom 范围) 的高清 dataURL，比 step.images 里 SVG dataURL 更鲜活
const previewEchartsRef = ref<InstanceType<typeof EChartsCanvas> | null>(null)
// 弹窗根节点 ref。用于手动绑 wheel 事件并显式 { passive: false }——
// 模板里 @wheel.prevent 会让 Chrome 报"non-passive scroll-blocking"警告，
// 因为 Vue 的 patchEvent 不显式传 passive 参数。
const previewModalRef = ref<HTMLDivElement | null>(null)
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

// 预览模式每张图都附带可选的 echartsPayload——这样左右/上下方向键导航时也能恢复活图
// 模式（之前因为只存 string[]，导航时丢了 payload 上下文，切到下一张就退化成 <img>）。
interface PreviewItem {
  url: string
  echartsPayload?: import('@shared/types').EChartsStepPayload
}

interface PreviewImageGroup {
  groupId: string
  items: PreviewItem[]
}

// 收集所有对话中的图片，按任务分组（用户图片 + 步骤图片合并到同一组）。
// 一个 step 通常只有一张图但有一个 step.echartsOption——把 payload 关联到 step.images[0]，
// 后续图（如果有）走纯 <img> 兜底（chart skill 当前是一 step 一图，不会触发；其它 skill
// 多图时活图能力本来也没注入）。
const allPreviewImages = computed((): PreviewImageGroup[] => {
  const result: PreviewImageGroup[] = []
  for (const group of agentTaskGroups.value) {
    const items: PreviewItem[] = []
    if (group.images?.length) {
      for (const url of group.images) items.push({ url })
    }
    for (const step of group.steps) {
      if (!step.images?.length) continue
      const payload = step.echartsOption
      items.push({ url: step.images[0], echartsPayload: payload })
      for (let i = 1; i < step.images.length; i++) {
        items.push({ url: step.images[i] })
      }
    }
    if (items.length > 0) {
      result.push({ groupId: group.id, items })
    }
  }
  return result
})

const resetPreviewTransform = () => {
  previewScale.value = 1
  previewTranslateX.value = 0
  previewTranslateY.value = 0
}

const openImagePreview = (
  url: string,
  echartsPayload?: import('@shared/types').EChartsStepPayload
) => {
  previewImageUrl.value = url
  // 仅当本次点击来自"活图"时填载荷；普通 SVG/PNG 图调用方传 undefined（不传也行），
  // 模态自然走 <img> 路径
  previewEchartsPayload.value = echartsPayload ?? null
  resetPreviewTransform()
  previewGroupIdx.value = -1
  previewImageIdx.value = -1
  for (let gi = 0; gi < allPreviewImages.value.length; gi++) {
    const imgIdx = allPreviewImages.value[gi].items.findIndex(it => it.url === url)
    if (imgIdx !== -1) {
      previewGroupIdx.value = gi
      previewImageIdx.value = imgIdx
      return
    }
  }
}

const closeImagePreview = () => {
  previewImageUrl.value = null
  previewEchartsPayload.value = null
  // previewEchartsRef.value 由 Vue 在子组件 unmount 时自动写回 null，无需手动清零
  isDraggingImage.value = false
}

// ==================== 图片右键菜单 ====================
const { copyImage } = useImageActions()
const imageContextMenu = reactive<{ show: boolean; x: number; y: number; url: string | null }>({
  show: false, x: 0, y: 0, url: null
})

const openImageContextMenu = (e: MouseEvent, url: string) => {
  e.preventDefault()
  e.stopPropagation()
  imageContextMenu.show = true
  imageContextMenu.x = e.clientX
  imageContextMenu.y = e.clientY
  imageContextMenu.url = url
}

// 「活图」EChartsCanvas 触发右键菜单时,组件 emit 的载荷形如 { event, dataUrl }——
// 模板里直接写带 TS 类型的内联箭头函数会被 Vue 模板编译器拒（它不支持模板表达式里的
// 类型注解）；抽到 <script setup> 里做薄包装后模板写法回退到无类型的 @contextmenu="onEchartsContextMenu"
const onEchartsContextMenu = (payload: { event: MouseEvent; dataUrl: string }) => {
  openImageContextMenu(payload.event, payload.dataUrl)
}

const closeImageContextMenu = () => {
  imageContextMenu.show = false
  imageContextMenu.url = null
}

const navigatePreview = (groupIdx: number, imageIdx: number) => {
  const groups = allPreviewImages.value
  if (groupIdx < 0 || groupIdx >= groups.length) return
  const group = groups[groupIdx]
  if (imageIdx < 0 || imageIdx >= group.items.length) return
  const item = group.items[imageIdx]
  previewGroupIdx.value = groupIdx
  previewImageIdx.value = imageIdx
  previewImageUrl.value = item.url
  // PreviewItem 同时携带 echartsPayload，导航到活图项时自动还原可交互模式；
  // 普通图项 echartsPayload 为 undefined → null，模板自然走 <img> 路径。
  previewEchartsPayload.value = item.echartsPayload ?? null
  resetPreviewTransform()
}

// 同组内左右切换
const canGoLeft = computed(() => previewImageIdx.value > 0)
const canGoRight = computed(() => {
  const g = allPreviewImages.value[previewGroupIdx.value]
  return g ? previewImageIdx.value < g.items.length - 1 : false
})
const canGoUp = computed(() => previewGroupIdx.value > 0)
const canGoDown = computed(() => previewGroupIdx.value >= 0 && previewGroupIdx.value < allPreviewImages.value.length - 1)

const goLeft = () => canGoLeft.value && navigatePreview(previewGroupIdx.value, previewImageIdx.value - 1)
const goRight = () => canGoRight.value && navigatePreview(previewGroupIdx.value, previewImageIdx.value + 1)
const goUp = () => {
  if (!canGoUp.value) return
  const prevGroup = allPreviewImages.value[previewGroupIdx.value - 1]
  navigatePreview(previewGroupIdx.value - 1, prevGroup.items.length - 1)
}
const goDown = () => canGoDown.value && navigatePreview(previewGroupIdx.value + 1, 0)

const currentGroupImageCount = computed(() => allPreviewImages.value[previewGroupIdx.value]?.items.length ?? 0)

// 滚轮缩放
const handlePreviewWheel = (e: WheelEvent) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  const newScale = Math.max(0.1, Math.min(10, previewScale.value + delta * previewScale.value))
  previewScale.value = newScale
}

// 显式以 { passive: false } 绑定 wheel——告诉浏览器我们故意要 preventDefault（缩放），
// 避免模板 @wheel.prevent 触发 "non-passive scroll-blocking" 警告。
// previewModalRef 是 v-if 元素，每次弹窗出现/关闭都会重新挂载/卸载。
watch(previewModalRef, (el, _old, onCleanup) => {
  if (!el) return
  el.addEventListener('wheel', handlePreviewWheel, { passive: false })
  onCleanup(() => el.removeEventListener('wheel', handlePreviewWheel))
})

// 双击重置
const handlePreviewDblClick = () => resetPreviewTransform()

// 拖拽平移
const handlePreviewMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return
  // 「活图」预览模态：mousedown 落在 EChartsCanvas 内部时直接放行——echarts 自己要用
  // mousedown 启动 dataZoom 拖动 / brush 框选 / legend 点击等核心交互，外层包装的
  // 「拖动平移」一旦抢断这个事件就把活图最值钱的能力废掉了。空白区域（图表四周的
  // padding）仍然走拖动平移，保持普通预览的视觉操作惯例。
  // 注意：用 closest 而不是 ===，因为 echarts SVG renderer 渲染出来的 <g><path> 等
  // 子节点是真正的事件 target，不是 .echarts-canvas 这个父容器
  if (previewEchartsPayload.value && (e.target as HTMLElement | null)?.closest?.('.echarts-canvas')) {
    return
  }
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

// 活图预览容器的具体 width/height —— 按 viewport 90vw × 90vh 做 contain 算法，
// 同时保留后端建议尺寸作为天花板（小图不放大）。父容器拿到具体尺寸后子组件
// EChartsCanvas mode='preview' 用 width:100%/height:100% 跟随，echarts 实例内部
// 的 ResizeObserver 会在 winSize 变化时自动 resize。
const PREVIEW_MAX_WIDTH_VW = 0.9
const PREVIEW_MAX_HEIGHT_VH = 0.9
const PREVIEW_ABS_MAX_WIDTH = 1600
const previewEchartsBoxStyle = computed<Record<string, string>>(() => {
  if (!previewEchartsPayload.value) return {} as Record<string, string>
  const { width: pw, height: ph } = previewEchartsPayload.value
  const ratio = pw / Math.max(1, ph)
  const maxW = Math.min(winSize.value.w * PREVIEW_MAX_WIDTH_VW, PREVIEW_ABS_MAX_WIDTH, pw)
  const maxH = Math.min(winSize.value.h * PREVIEW_MAX_HEIGHT_VH, ph)
  // contain：先按宽度满铺，若反推高度超 maxH 再翻转改用高度满铺
  let w = maxW
  let h = w / ratio
  if (h > maxH) {
    h = maxH
    w = h * ratio
  }
  return {
    width: `${Math.round(w)}px`,
    height: `${Math.round(h)}px`,
    transform: previewTransform.value
  }
})

// 拖放放下（支持文档和图片）
const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = false
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    await ingestAttachmentFiles(files)
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
    // Cmd/Ctrl+C 复制当前预览的大图（仅在没有文本选区时触发，避免覆盖正常的文本复制）
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection()?.toString()
      if (!sel) {
        e.preventDefault()
        e.stopImmediatePropagation()
        // 「活图」预览时优先用 echarts 实例的 getDataURL 拿当前实时（含用户拖过的 dataZoom）
        // 高清 PNG，比把后端 SVG 兜底图再 canvas 转一遍质量更好；普通图沿用 previewImageUrl
        const url = previewEchartsRef.value?.getDataURL('png') || previewImageUrl.value
        if (url) copyImage(url).catch(() => { /* toast 已显示 */ })
        return
      }
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
    if (showFreeModeConfirm.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      cancelFreeMode()
      return
    }
    if (showClearConfirm.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      cancelClearMessages()
      return
    }
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
    // message step 把思考块剥离后再作为 size dep——思考块单行呈现且展开容器为固定高度，
    // reasoning 文本流式刷新不会改变列表项高度。仅在用户主动切换思考块展开/收起时才参与重算
    let contentForSize: string | undefined = item.step.content
    let thinkingExpandedForSize: boolean | undefined
    if (item.step.type === 'message' && contentForSize?.includes('🤔')) {
      contentForSize = parseThinking(contentForSize).body
      thinkingExpandedForSize = expandedThinkingSteps.value.has(item.step.id)
    }
    return [
      contentForSize,
      item.step.toolResult,
      item.step.isStreaming,
      item.step.images?.length,
      // 活图（echartsOption）出现/消失会改变这一行高度（ImagePlaceholder vs EChartsCanvas
      // 的最大尺寸不同），让 size dep 把它感知到，避免虚拟滚动布局错位
      !!item.step.echartsOption,
      item.isFirstStep,
      isStandaloneAssistant.value,
      thinkingExpandedForSize,
    ]
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
  updateWinSize()
  window.addEventListener('resize', updateWinSize)
  document.addEventListener('keydown', handleKeyDown)
  // 捕获阶段：终端聚焦时 Ctrl+字母 的 keydown 可能无法冒泡到 document，导致无法用「第二键」取消以 Control 为 PTT 键时的长按计时
  document.addEventListener('keydown', handlePTTKeyDown, true)
  document.addEventListener('keyup', handlePTTKeyUp, true)
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
  window.removeEventListener('resize', updateWinSize)
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('keydown', handlePTTKeyDown, true)
  document.removeEventListener('keyup', handlePTTKeyUp, true)
  window.removeEventListener('blur', handlePTTWindowBlur)
  const el = scrollerRef.value?.$el as HTMLElement | undefined
  if (el) {
    el.removeEventListener('scroll', updateScrollPosition)
    el.removeEventListener('click', handleCodeBlockClick)
    el.removeEventListener('contextmenu', handleFilePathContextMenu)
  }
})

// 监听 visible 变化，保存和恢复滚动位置
watch(() => props.visible, async (visible, wasVisible) => {
  if (!visible && wasVisible) {
    // 面板隐藏时，保存当前滚动位置
    if (messagesRef.value && currentTabId.value) {
      const scrollTop = messagesRef.value.scrollTop
      terminalStore.setAiScrollTop(currentTabId.value, scrollTop)
    }
  } else if (visible && !wasVisible) {
    // 面板显示时，恢复滚动位置
    warmupMessageList()
    await nextTick()
    if (messagesRef.value && currentTabId.value) {
      const savedScrollTop = terminalStore.getAiScrollTop(currentTabId.value)
      if (savedScrollTop !== undefined) {
        messagesRef.value.scrollTop = savedScrollTop
      }
    }
  }
}, { flush: 'post' })

// 监听 tabId 变化（用于分屏模式下切换激活窗格）
watch(() => props.tabId, async (newTabId, oldTabId) => {
  if (oldTabId && messagesRef.value) {
    // 保存旧 tab 的滚动位置
    const scrollTop = messagesRef.value.scrollTop
    terminalStore.setAiScrollTop(oldTabId, scrollTop)
  }

  if (newTabId) {
    // 恢复新 tab 的滚动位置
    await nextTick()
    if (messagesRef.value) {
      const savedScrollTop = terminalStore.getAiScrollTop(newTabId)
      if (savedScrollTop !== undefined) {
        messagesRef.value.scrollTop = savedScrollTop
      }
    }
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
        <!-- Agent 模式设置 -->
        <div class="agent-settings">
          <!-- 执行模式选择器（三选一：严格/宽松/自由） -->
          <div class="execution-mode-selector">
            <button 
              class="mode-option mode-option-strict" 
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
        <div v-if="currentSystemInfo" class="system-info-left host-info-trigger">
          <span class="system-icon">💻</span>
          <span class="system-text">
            {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
            · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
          </span>
          <span class="hover-hint">▾</span>
        </div>
        <!-- 悬浮主机信息面板（固定锚定在信息栏左侧） -->
        <div v-if="currentSystemInfo" class="host-info-popover">
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
        <!-- 从原 ai-header 迁移的控件，保持"最右侧"的对齐 -->
        <div class="ai-header-actions">
          <select
            v-if="aiProfiles.length > 0"
            class="model-select model-select-sm"
            :value="activeAiProfile?.id || ''"
            :title="t('ai.switchModel')"
            @change="changeAiProfile(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
              {{ profile.name }} ({{ profile.model }}){{ profile.modelType === 'vision' ? ` [${t('aiSettings.modelTypeVision')}]` : '' }}
            </option>
          </select>
          <button class="btn-icon btn-icon-sm" @click="clearMessages" :title="t('ai.clearChat')">
            <Trash2 :size="13" />
          </button>
          <button class="btn-icon btn-icon-sm" @click="handleClose" :title="t('ai.closePanel')">
            <X :size="13" />
          </button>
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
          historySearchKeyword,
          isLoadingHistory,
          isLoadingAllHistory,
          isHistorySearchLoading,
          historyFullTextSearchActive,
          historySearchTotalMatched,
          executionMode,
          isStandaloneAssistant,
          hasNewMessage,
          displayedExamples,
          shuffleSpinning
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
              
              <!-- 独立助手：可点击的能力示例网格（25 条池子，首屏精选 8，"换一批"洗牌） -->
              <template v-if="isStandaloneAssistant">
                <div class="scenarios-header">
                  <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
                  <button
                    class="shuffle-btn"
                    :class="{ spinning: shuffleSpinning }"
                    :title="t('ai.agentWelcome.shuffleTooltip')"
                    @click="shuffleScenarios"
                  >
                    <Shuffle :size="13" />
                    <span>{{ t('ai.agentWelcome.shuffleExamples') }}</span>
                  </button>
                </div>
                <p class="scenarios-hint">{{ t('ai.agentWelcome.examplesHint') }}</p>
                <div class="scenario-grid">
                  <button
                    v-for="example in displayedExamples"
                    :key="example.id"
                    class="scenario-card"
                    :data-category="example.category"
                    :title="t(`ai.agentWelcome.scenarios.${example.id}.prompt`)"
                    @click="handleScenarioClick(example)"
                  >
                    <span class="scenario-icon">{{ example.icon }}</span>
                    <span class="scenario-title">{{ t(`ai.agentWelcome.scenarios.${example.id}.title`) }}</span>
                    <span class="scenario-subtitle">{{ t(`ai.agentWelcome.scenarios.${example.id}.subtitle`) }}</span>
                  </button>
                </div>
              </template>
              <!-- 终端模式：保持原有的纯文本示例列表 -->
              <template v-else>
                <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
                <ul>
                  <li>{{ t('ai.agentWelcome.example1') }}</li>
                  <li>{{ t('ai.agentWelcome.example2') }}</li>
                  <li>{{ t('ai.agentWelcome.example3') }}</li>
                  <li>{{ t('ai.agentWelcome.example4') }}</li>
                </ul>
              </template>

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
                <div class="history-modal-search">
                  <input
                    ref="historySearchInputRef"
                    type="search"
                    class="history-search-input"
                    :placeholder="t('ai.agentWelcome.historySearchPlaceholder')"
                    :value="historySearchKeyword"
                    autocomplete="off"
                    @input="setHistorySearchKeyword(($event.target as HTMLInputElement).value)"
                    @keydown.enter.prevent="flushHistorySearch()"
                  />
                  <button
                    type="button"
                    class="history-search-submit"
                    :title="t('ai.agentWelcome.historySearchSubmit')"
                    :disabled="isLoadingAllHistory || isHistorySearchLoading"
                    @click="flushHistorySearch()"
                  >
                    <Search :size="18" />
                  </button>
                  <button
                    v-if="historySearchKeyword.trim()"
                    type="button"
                    class="history-search-clear"
                    :title="t('ai.agentWelcome.historySearchClear')"
                    @click="clearHistorySearch()"
                  >
                    ×
                  </button>
                </div>
                <div
                  v-if="
                    historyFullTextSearchActive &&
                    historySearchKeyword.trim() &&
                    !isLoadingAllHistory &&
                    isHistorySearchLoading
                  "
                  class="history-search-in-progress"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 class="history-search-loader-icon" :size="16" aria-hidden="true" />
                  <span>{{ t('ai.agentWelcome.historySearchLoading') }}</span>
                </div>
                <p
                  v-else-if="
                    historyFullTextSearchActive &&
                    historySearchKeyword.trim() &&
                    !isLoadingAllHistory
                  "
                  class="history-search-matched-hint"
                >
                  {{ t('ai.agentWelcome.historySearchMatchedCount', { count: historySearchTotalMatched }) }}
                </p>
                <div class="history-modal-body">
                  <div v-if="isLoadingAllHistory" class="history-loading">
                    {{ t('ai.agentWelcome.historyLoading') }}
                  </div>
                  <div
                    v-else-if="
                      historyFullTextSearchActive &&
                      isHistorySearchLoading &&
                      allHistory.length === 0
                    "
                    class="history-search-wait-area"
                  ></div>
                  <div v-else-if="allHistory.length === 0" class="history-empty">
                    {{
                      historySearchKeyword.trim()
                        ? t('ai.agentWelcome.noSearchResult')
                        : t('ai.agentWelcome.noRecentHistory')
                    }}
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
                      <span
                        class="history-task"
                        v-html="highlightHistoryTaskHtml(record.userTask, historySearchKeyword, 80)"
                      />
                      <span class="history-meta">
                        <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
                        <span class="history-time">{{ formatHistoryTime(record.timestamp + record.duration) }}</span>
                      </span>
                    </div>
                    <button
                      v-if="hasMoreHistory"
                      class="history-load-more"
                      type="button"
                      :disabled="isHistorySearchLoading"
                      @click="loadMoreHistory"
                    >
                      {{ t('ai.agentWelcome.loadMore', '加载更多...') }}
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
                    <span class="user-task-text">{{ item.group!.userTask }}</span>
                    <div v-if="item.group!.images && item.group!.images.length > 0" class="message-images">
                      <img
                        v-for="(imgUrl, imgIdx) in item.group!.images"
                        :key="imgIdx"
                        :src="imgUrl"
                        class="message-image"
                        @click="openImagePreview(imgUrl)"
                        @contextmenu="openImageContextMenu($event, imgUrl)"
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

              <!--
                单个步骤
                tool_call 步骤的左竖条按"执行结果"着色：
                  - success === undefined  → 灰色占位（risk-pending），覆盖"流式生成 + 工具执行中"整段未完成期
                  - success === true       → 绿色（exec-success）
                  - success === false      → 红色（exec-failed）
                其他步骤类型保持现有风险色。
              -->
              <div v-else-if="item.type === 'step'" class="agent-step-virtual" :class="{ 'first-step': item.isFirstStep }">
                <div 
                  class="agent-step-inline"
                  :class="[
                    isInitialPreparingStep(item.step!) ? 'message' : item.step!.type,
                    item.step!.type === 'tool_call' ? getExecStatusClass(item.step!) : getRiskClass(item.step!.riskLevel),
                    {
                      'step-rejected': item.step!.rejected === true,
                      'risk-pending': item.step!.type === 'tool_call' && item.step!.success === undefined
                    }
                  ]"
                >
                  <span class="step-icon">{{ isInitialPreparingStep(item.step!) ? getStepIcon('message') : getStepIcon(item.step!.type) }}</span>
                  <div class="step-content">
                    <!-- 初始"正在准备..."占位：借用 message step 的整套视觉壳（agent-message-stack + ThinkingBlock 流式态），
                         切换到真正的 message step 时只是 ThinkingBlock 文字内部的"正在准备..." → "思考中 N.Ns" 变化，外层布局完全不变 -->
                    <div v-if="isInitialPreparingStep(item.step!)" class="agent-message-stack">
                      <ThinkingBlock
                        reasoning=""
                        :is-streaming="true"
                        :expanded="false"
                        :started-at="item.step!.timestamp"
                        :label="item.step!.content"
                      />
                    </div>
                    <div v-else-if="item.step!.type === 'message'" class="agent-message-stack">
                      <ThinkingBlock
                        v-if="parseThinking(item.step!.content).thinking"
                        :reasoning="parseThinking(item.step!.content).thinking!.reasoning"
                        :is-streaming="!parseThinking(item.step!.content).thinking!.isDone"
                        :expanded="isThinkingExpanded(item.step!.id)"
                        :started-at="item.step!.timestamp"
                        :cached-duration-ms="getCachedThinkingDuration(item.step!.id)"
                        @toggle="toggleThinkingExpand(item.step!.id)"
                        @finalize="cacheThinkingDuration(item.step!.id, $event)"
                      />
                      <div
                        v-if="parseThinking(item.step!.content).body"
                        class="step-text step-analysis markdown-content"
                        :class="{ 'is-streaming': item.step!.isStreaming }"
                        v-html="renderMarkdown(parseThinking(item.step!.content).body)"
                      ></div>
                      <!-- 任务完成尾注：作为 message step 的尾巴，仅在 group 完成且这是 group 的最后一个
                           message step 时显示。任务完成那一刻 group.finalResult 设置 → 尾注从 stack 末尾
                           "长出"几像素，不引起独立 item 出现/消失，避免列表重排跳动。
                           agent-final-footer--first-show 仅在该 group 第一次显示尾注时附加，触发一次性
                           fade-in 动画；animationend 后 markFooterAnimated 写入 Set，后续虚拟滚动 remount
                           不再附加 class，避免动画重播闪烁 -->
                      <div
                        v-if="shouldShowTaskCompleteFooter(item)"
                        class="agent-final-footer"
                        :class="{ 'agent-final-footer--first-show': isFooterFirstShow(item.group?.id) }"
                        @animationend="markFooterAnimated(item.group?.id)"
                      >
                        <span class="agent-final-footer-icon">✓</span>
                        <span>{{ t('ai.taskComplete') }}</span>
                        <button
                          v-if="canShowGroupMenu(item.group)"
                          type="button"
                          class="agent-group-menu-trigger"
                          :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                          :title="t('ai.fork.tooltip')"
                          @click.stop="toggleGroupMenu(item.group, $event)"
                        >
                          <MoreHorizontal :size="14" />
                        </button>
                      </div>
                    </div>
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
                    <div v-else-if="item.step!.webSearchResults && item.step!.webSearchResults.length > 0" class="step-text web-search-content">
                      <span class="web-search-header" @click="toggleWebSearchExpand(item.step!.id)">
                        <span class="web-search-summary">{{ t('ai.webSearch.foundResults', { count: item.step!.webSearchResults.length }) }}</span>
                        <span class="web-search-expand-icon" :class="{ expanded: expandedWebSearchSteps.has(item.step!.id) }">▶</span>
                      </span>
                      <ul v-if="expandedWebSearchSteps.has(item.step!.id)" class="web-search-list">
                        <li
                          v-for="(r, rIdx) in item.step!.webSearchResults"
                          :key="rIdx"
                          class="web-search-item"
                        >
                          <a
                            class="web-search-link"
                            href="#"
                            :title="r.url"
                            @click.prevent="openWebSearchLink(r.url)"
                          >{{ r.title || r.url }}</a>
                          <span class="web-search-host">{{ getHostname(r.url) }}</span>
                        </li>
                      </ul>
                    </div>
                    <!-- tool_call 步骤的 content 是「执行命令: <command>」「读取文件: <path>」这类
                         状态行，命令/路径里完全可能出现 #、*、--- 这类 Markdown 语法字符（如 shell
                         注释 `# 启动调试适配器`、option `--name`、heredoc `===` 等）。直接走
                         renderMarkdown 会把它们解析成标题、加粗、分隔线，破坏命令原貌，所以单独
                         走纯文本 + pre-wrap 渲染，保留原样的换行与符号。
                         例外：toolArgs 含 http(s) url 字段时把 URL 部分包成 <a>（自动通过
                         Electron setWindowOpenHandler 走系统浏览器），其余仍走纯文本——既能点击，
                         命令安全也不变。renderToolCallContent 把 content 拆成 [前缀, url, 后缀]，
                         三段都走 Vue 文本插值，零 XSS 风险。 -->
                    <ToolCallContent v-else-if="item.step!.type === 'tool_call'" :content="item.step!.content" :toolArgs="item.step!.toolArgs" />
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
                    <!-- 拒绝步骤（rejected）的 content 与 toolResult 在语义上是同一句"用户拒绝…"，
                         不需要再下方重复一份 step-result。其他场景下 toolResult 与 content 不同则展示。 -->
                    <div v-if="item.step!.toolResult && !item.step!.rejected && item.step!.toolResult !== item.step!.content && item.step!.type !== 'asking' && !item.step!.subAgents" class="step-result">
                      <pre>{{ item.step!.toolResult }}</pre>
                    </div>
                    <!-- 「活图」优先：chart skill 在 svg 模式下投递 echartsOption（同时也带 SVG 兜底到 step.images），
                         前端把它实例化成可交互的 ECharts，单击放大/右键复制走 EChartsCanvas 内部 getDataURL 的高清 PNG。
                         单击时把 step.images[0]（SVG dataURL）一起传给 openImagePreview，让导航定位能在 group 中找到当前位置。 -->
                    <div v-if="item.step!.echartsOption" class="step-images">
                      <EChartsCanvas
                        :payload="item.step!.echartsOption"
                        :alt="item.step!.toolResult || 'chart'"
                        mode="thumb"
                        @preview="openImagePreview(item.step!.images?.[0] ?? '', item.step!.echartsOption)"
                        @contextmenu="onEchartsContextMenu"
                      />
                    </div>
                    <div v-else-if="item.step!.images && item.step!.images.length > 0" class="step-images">
                      <img
                        v-for="(imgUrl, imgIdx) in item.step!.images"
                        :key="imgIdx"
                        :src="imgUrl"
                        :alt="item.step!.toolResult || `image ${imgIdx + 1}`"
                        class="step-image"
                        @click="openImagePreview(imgUrl)"
                        @contextmenu="openImageContextMenu($event, imgUrl)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 最终结果：仅失败 / 中断时渲染独立卡片（含错误信息）；
                   成功时不渲染——message step 已经完整呈现思考块 + 正文，
                   独立的"任务完成"卡反而会引起列表跳动。 -->
              <div v-else-if="item.type === 'final_result' && (item.group!.finalResult!.startsWith('❌') || item.group!.finalResult!.startsWith('⚠️'))">
                <div class="message assistant">
                  <div class="message-wrapper agent-final-wrapper">
                    <div
                      class="message-content agent-final-content"
                      :class="{ 'is-error': item.group!.finalResult!.startsWith('❌'), 'is-aborted': item.group!.finalResult!.startsWith('⚠️') }"
                    >
                      <div class="agent-final-header">
                        <span class="final-icon">{{ item.group!.finalResult!.startsWith('❌') ? '❌' : '⚠️' }}</span>
                        <span class="final-title">{{ item.group!.finalResult!.startsWith('❌') ? t('ai.taskFailed') : t('ai.taskAborted') }}</span>
                      </div>
                      <div class="agent-final-body markdown-content" v-html="renderMarkdown(item.group!.finalResult!.replace(/^[❌⚠️]\s*(Agent\s*(执行失败|运行出错)[:\s]*)?/, ''))"></div>
                      <div v-if="canShowGroupMenu(item.group)" class="agent-final-footer agent-final-footer--in-card">
                        <button
                          type="button"
                          class="agent-group-menu-trigger"
                          :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                          :title="t('ai.fork.tooltip')"
                          @click.stop="toggleGroupMenu(item.group, $event)"
                        >
                          <MoreHorizontal :size="14" />
                        </button>
                      </div>
                    </div>
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
                    <div class="confirm-tool-name">{{ pendingConfirm.displayName || getToolDisplayName(pendingConfirm.toolName) }}</div>
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
        :parsing-docs="parsingDocs"
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
      ref="previewModalRef"
      class="image-preview-modal" 
      @click="closeImagePreview"
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
        <!-- 「活图」预览：当点击的是 chart skill 投递的活图时，模态里也用 EChartsCanvas 渲染，
             保留 tooltip / dataZoom / legend toggle 等所有交互能力。复制图片 / 另存为通过
             previewEchartsRef.getDataURL() 拿当前实时（含用户拖过的 dataZoom 范围）高清 PNG。
             缩放和拖拽也作用在 EChartsCanvas 上——CSS transform 控制外层包装，echarts 实例
             保持原始尺寸不影响交互精度。-->
        <div
          v-if="previewEchartsPayload"
          class="image-preview-full image-preview-echarts"
          :class="{ 'dragging': isDraggingImage }"
          :style="previewEchartsBoxStyle"
          @mousedown="handlePreviewMouseDown"
          @dblclick="handlePreviewDblClick"
        >
          <EChartsCanvas
            ref="previewEchartsRef"
            :payload="previewEchartsPayload"
            mode="preview"
            @contextmenu="onEchartsContextMenu"
          />
        </div>
        <img
          v-else
          :src="previewImageUrl"
          class="image-preview-full"
          :class="{ 'dragging': isDraggingImage }"
          :style="{ transform: previewTransform }"
          @mousedown="handlePreviewMouseDown"
          @dblclick="handlePreviewDblClick"
          @contextmenu="openImageContextMenu($event, previewImageUrl!)"
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

  <!-- group 操作菜单：Teleport 到 body 避免被 vue-virtual-scroller 的 overflow:hidden 裁掉 -->
  <Teleport to="body">
    <div
      v-if="openGroupMenuId && openGroupMenuGroup"
      class="agent-group-menu"
      :style="{ top: groupMenuPosition.top + 'px', right: groupMenuPosition.right + 'px' }"
    >
      <button
        type="button"
        class="agent-group-menu-item"
        :disabled="forkingGroupIds.has(openGroupMenuGroup.id)"
        @click="handleForkFromGroup(openGroupMenuGroup)"
      >
        {{ t('ai.fork.action') }}
      </button>
    </div>
  </Teleport>

  <!-- 图片右键菜单：所有 <img> 共用，包括小缩略图和大图预览 -->
  <ImageContextMenu
    :show="imageContextMenu.show"
    :x="imageContextMenu.x"
    :y="imageContextMenu.y"
    :url="imageContextMenu.url"
    default-name="image"
    @close="closeImageContextMenu"
  />
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
  background: rgba(var(--accent-rgb), 0.15);
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

.model-select {
  padding: 4px 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  max-width: 160px;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.model-select:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* 聚焦态本身不叠加底色；鼠标离开后不会残留高亮，鼠标回到上方仍由 :hover 生效 */

/* 紧凑变体：嵌入 system-info-bar 时使用 */
.model-select-sm {
  padding: 2px 4px;
  font-size: 11px;
  height: 22px;
  max-width: 140px;
  border-radius: 4px;
}

.btn-icon-sm {
  width: 22px;
  height: 22px;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-icon-sm:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
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
  gap: 12px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
  container-type: inline-size;
  container-name: infobar;
  white-space: nowrap;
  position: relative;
}

/* ai-header-actions 固定在最右侧（无论 system-info-left 是否渲染） */
.ai-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.system-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}

/* 窄面板（如嵌入终端 tab 的 AI 侧栏）下隐藏辅助标签，只留图标/控件 */
@container infobar (max-width: 500px) {
  .system-info-left .system-text,
  .system-info-left .hover-hint {
    display: none;
  }
  .model-select-sm {
    max-width: 100px;
  }
}

@container infobar (max-width: 380px) {
  .model-select-sm {
    max-width: 70px;
  }
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
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  transition: all 0.2s ease;
  box-sizing: border-box;
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

/* 指向悬浮面板的三角形（挂在触发器上，天然对准 💻 图标） */
.host-info-trigger::after {
  content: '';
  position: absolute;
  top: calc(100% + 3px);
  left: 8px;
  width: 12px;
  height: 12px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
  transform: rotate(45deg);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.25s;
  z-index: 101;
  pointer-events: none;
}

/* 悬浮面板：固定锚定到信息栏左侧 */
.host-info-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
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
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              visibility 0.25s,
              transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 透明桥接区域，让鼠标能在触发器和面板之间移动而不丢失 hover */
.host-info-popover::before {
  content: '';
  position: absolute;
  top: -10px;
  left: 0;
  right: 0;
  height: 10px;
}

/* 悬停在触发器或面板上时，显示面板和箭头 */
.system-info-bar:has(.host-info-trigger:hover) .host-info-popover,
.system-info-bar:has(.host-info-popover:hover) .host-info-popover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.system-info-bar:has(.host-info-trigger:hover) .host-info-trigger::after,
.system-info-bar:has(.host-info-popover:hover) .host-info-trigger::after {
  opacity: 1;
  visibility: visible;
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
/* 错误诊断提示 —— 走 --brand-alert（警戒红），跨主题固定，
   与通用 --color-error 区分，保证"错误警告"的视觉强度各主题一致 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(var(--brand-alert-rgb), 0.15);
  border-bottom: 1px solid rgba(var(--brand-alert-rgb), 0.3);
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
  color: var(--brand-alert);
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
  background: var(--brand-alert);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-btn:hover:not(:disabled) {
  background: var(--brand-alert-end);
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
  background: rgba(var(--brand-alert-rgb), 0.2);
}

/* 选中内容提示 */
.selection-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(var(--color-info-rgb), 0.15);
  border-bottom: 1px solid rgba(var(--color-info-rgb), 0.3);
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
  color: var(--color-info);
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
  background: var(--color-info);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.selection-alert-btn:hover:not(:disabled) {
  background: var(--accent-secondary);
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
  border-left: 2px solid rgba(255, 255, 255, 0.06);
}

.standalone-mode .agent-step-virtual {
  margin-left: 48px;
}

.standalone-mode .agent-step-virtual.first-step {
  position: relative;
  padding-top: 4px;
  /* 头像为 absolute，虚拟列表按内容盒测量高度时会偏小导致裁切 */
  min-height: 46px;
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

/* Agent 执行模式 - 严格模式绿色内阴影（仅左右两边）
   走 --brand-vital（活力绿），表示"每条命令都需确认的安全守护状态"；
   默认的 relaxed 模式不加任何视觉效果，作为无感知的基线。 */
.ai-panel.mode-strict .ai-messages {
  box-shadow: 
    inset 30px 0 30px -20px rgba(var(--brand-vital-rgb), 0.35),
    inset -30px 0 30px -20px rgba(var(--brand-vital-rgb), 0.35);
}

/* Agent 执行模式 - 自由模式红色内阴影 + 脉冲警示（仅左右两边）
   走 --brand-alert（警戒红），跨主题固定 */
.ai-panel.mode-free .ai-messages {
  box-shadow: 
    inset 40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4),
    inset -40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4);
  animation: free-mode-pulse 2s ease-in-out infinite;
}

@keyframes free-mode-pulse {
  0%, 100% {
    box-shadow: 
      inset 40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4),
      inset -40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4);
  }
  50% {
    box-shadow: 
      inset 50px 0 50px -30px rgba(var(--brand-alert-rgb), 0.5),
      inset -50px 0 50px -30px rgba(var(--brand-alert-rgb), 0.5);
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
  box-shadow: 0 2px 12px rgba(var(--accent-rgb), 0.4);
  transition: all 0.2s ease;
  animation: bounceIn 0.3s ease;
  z-index: 10;
  width: fit-content;
  margin: 0 auto;
}

.new-message-indicator:hover {
  background: var(--accent-secondary);
  transform: translateX(-50%) scale(1.05);
  box-shadow: 0 4px 16px rgba(var(--accent-rgb), 0.5);
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
  background: var(--color-warning);
}

.context-mini-bar.danger {
  background: var(--color-error);
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
  background: var(--color-warning);
}

.context-bar-fill.danger {
  background: var(--color-error);
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
  background: var(--brand-vital);
}

.strict-badge.free {
  background: var(--color-error);
}

/* ==================== 独立助手能力示例网格 ==================== */

.scenarios-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  margin-bottom: 4px;
}

.scenarios-header .welcome-section-title {
  margin: 0;
}

.shuffle-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  flex-shrink: 0;
}

.shuffle-btn:hover {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-decorative-primary) 60%, var(--border-color));
  background: color-mix(in srgb, var(--accent-decorative-primary) 8%, transparent);
}

.shuffle-btn:active {
  transform: scale(0.96);
}

.shuffle-btn :deep(svg) {
  transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}

.shuffle-btn:hover :deep(svg),
.shuffle-btn.spinning :deep(svg) {
  transform: rotate(360deg);
}

.scenarios-hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.scenario-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 6px;
}

/* 宽面板（>= 760px）切到 4 列：独立助手 tab 占满主区时常见，让信息密度更高 */
@media (min-width: 760px) {
  .scenario-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

/* 中等宽度（>= 520px）切到 3 列，避免 2 列时单卡过宽 */
@media (min-width: 520px) and (max-width: 759px) {
  .scenario-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

/*
 * 两行布局：
 *   ┌──────────────────────────┐
 *   │ 📊  数据可视化            │
 *   │     柱状图 + 折线图        │
 *   └──────────────────────────┘
 * 设计取舍：
 *   - 去掉 tag 胶囊（emoji + 标题已能表达类别，胶囊重复且增重）
 *   - 卡片背景透明、边框 50% 透明，hover 才浅染——一眼看到的不是"8 个独立按钮"，
 *     而是"一片可点的能力网格"，整体噪点显著下降
 *   - 高度从 76px 收到 ~52px，减小 padding，让 8 张卡视觉占用更轻
 */
.scenario-card {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  grid-template-areas:
    "icon title"
    "icon subtitle";
  align-items: center;
  gap: 0 10px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.2s ease,
              background 0.2s ease;
  position: relative;
  overflow: hidden;
  min-height: 52px;
}

.scenario-card:hover {
  border-color: color-mix(in srgb, var(--accent-decorative-primary) 55%, var(--border-color));
  background: color-mix(in srgb, var(--accent-decorative-primary) 6%, transparent);
  transform: translateY(-1px);
}

.scenario-card:active {
  transform: translateY(0);
}

.scenario-icon {
  grid-area: icon;
  font-size: 20px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.scenario-title {
  grid-area: title;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  align-self: end;
  margin-bottom: 1px;
  /* 单行省略，避免长标题撑破卡片高度 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scenario-subtitle {
  grid-area: subtitle;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
  align-self: start;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  background: linear-gradient(135deg, rgba(var(--brand-vital-rgb), 0.2) 0%, rgba(var(--brand-vital-rgb), 0.1) 100%);
  color: var(--brand-vital);
  box-shadow: 0 0 0 1px rgba(var(--brand-vital-rgb), 0.3);
}

.history-status-icon.failed {
  background: linear-gradient(135deg, rgba(var(--color-error-rgb), 0.2) 0%, rgba(var(--color-error-rgb), 0.1) 100%);
  color: var(--color-error);
  box-shadow: 0 0 0 1px rgba(var(--color-error-rgb), 0.3);
}

.history-status-icon.aborted {
  background: linear-gradient(135deg, rgba(var(--color-warning-rgb), 0.2) 0%, rgba(var(--color-warning-rgb), 0.1) 100%);
  color: var(--color-warning);
  box-shadow: 0 0 0 1px rgba(var(--color-warning-rgb), 0.3);
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
  /* 顶距单一来源：与 .history-modal max-height 联动 */
  --history-modal-top-gap: max(48px, min(10vh, 88px));
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: var(--history-modal-top-gap);
  padding-bottom: 24px;
  box-sizing: border-box;
  overflow-y: auto;
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
  /* 与 overlay padding 对齐：内容再多也只撑满剩余视窗，由 body 内部滚动 */
  max-height: min(80vh, calc(100vh - var(--history-modal-top-gap) - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
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
  flex-shrink: 0;
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

.history-modal-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.history-search-in-progress {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 24px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-secondary));
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 65%, transparent);
  flex-shrink: 0;
}

.history-search-loader-icon {
  flex-shrink: 0;
  animation: spin 0.9s linear infinite;
  color: color-mix(in srgb, var(--accent-primary) 75%, var(--text-muted));
}

.history-search-wait-area {
  flex: 1;
  min-height: 120px;
}

.history-search-matched-hint {
  margin: 0;
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 24px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  background: var(--bg-secondary);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 65%, transparent);
  flex-shrink: 0;
}

.history-search-input {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s ease;
}

.history-search-input:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
}

.history-search-input::-webkit-search-cancel-button {
  display: none;
}

.history-search-submit {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent-primary) 22%, var(--bg-hover));
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color));
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.history-search-submit:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-primary) 32%, var(--bg-hover));
}

.history-search-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.history-search-clear {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.history-search-clear:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.history-modal-list .history-search-mark {
  background: color-mix(in srgb, var(--accent-primary) 38%, transparent);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}

.history-modal-body {
  flex: 1;
  min-height: 0;
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
  background: var(--chat-user-bubble-bg);
  /* 气泡文字色：主题可在自己块内覆盖 --chat-user-bubble-color
     （蓝主题深蓝底用白字），默认 fallback 继承正文色。 */
  color: var(--chat-user-bubble-color, var(--text-primary));
  border: 1px solid var(--chat-user-bubble-border);
  border-radius: 12px 12px 4px 12px;
  user-select: text;
  cursor: text;
}

.message.user .message-content .user-task-text {
  white-space: pre-wrap;
  word-break: break-word;
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

/* message-content 设 cursor:text 时子链接需恢复手形光标（Markdown 正文样式见 styles/markdown-content.css） */
.message-content :deep(a[href]),
.message-content :deep(.file-path-link),
.message-content :deep(code.file-path-link),
.agent-final-body :deep(a[href]),
.agent-final-body :deep(.file-path-link),
.agent-final-body :deep(code.file-path-link) {
  cursor: pointer;
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
  gap: 10px;
  flex-wrap: nowrap;
  flex-shrink: 0;
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
  flex-shrink: 0;
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

/* 严格模式按钮 —— 产品级活力绿（守护/安全），跨主题固定，与自由模式红对称 */
.mode-option-strict.active {
  background: var(--brand-vital);
  color: #fff;
}

.mode-option-strict:hover:not(.active) {
  background: rgba(var(--brand-vital-rgb), 0.15);
  color: var(--brand-vital);
}

/* 自由模式按钮 —— 产品级警戒红，跨主题固定 */
.mode-option-free.active {
  background: var(--brand-alert);
}

.mode-option-free:hover:not(.active) {
  background: rgba(var(--brand-alert-rgb), 0.15);
  color: var(--brand-alert);
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
  color: var(--brand-alert);
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
  color: var(--brand-alert);
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
  color: var(--color-error) !important;
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
  border: 2px solid rgba(var(--brand-vital-rgb), 0.2);
  border-top-color: var(--brand-vital);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  box-shadow: 0 0 8px rgba(var(--brand-vital-rgb), 0.3);
}

.thinking-text {
  font-size: 13px;
  /* 渐变文字动画 */
  background: linear-gradient(
    90deg,
    rgba(var(--brand-vital-rgb), 0.75) 0%,
    rgba(var(--brand-vital-rgb), 1) 50%,
    rgba(var(--brand-vital-rgb), 0.75) 100%
  );
  background-size: 200% 100%;
  animation: gradient-flow 2s linear infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  color: rgba(var(--brand-vital-rgb), 0.75);
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
  background: rgba(var(--brand-vital-rgb), 0.1);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 13px;
  font-weight: 500;
}

/* 失败状态的样式 */
.agent-final-content.is-error .agent-final-header {
  background: rgba(var(--color-error-rgb), 0.1);
}

.agent-final-content.is-error {
  border-color: rgba(var(--color-error-rgb), 0.2);
}

.agent-final-content.is-aborted .agent-final-header {
  background: rgba(var(--color-warning-rgb), 0.1);
}

.agent-final-content.is-aborted {
  border-color: rgba(var(--color-warning-rgb), 0.2);
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
  border-left: 3px solid var(--color-success);
  background: rgba(var(--color-success-rgb), 0.08);
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

/* 成功完成的静默尾注：在最终消息下方轻轻浮出一行，不再用整张绿色卡片。
   入场动画通过 agent-final-footer--first-show 一次性附加，animationend 后由 JS 把
   该 group id 加入 animatedFooters Set，class 不再附加 → 后续虚拟滚动 unmount/mount
   不会重播动画，避免"翻历史一路滑入闪烁"的回归。

   ⚠️ UX 不变量：footer 的 DynamicScroller item size 必须恒定，与 footer 内
      任何子元素的存在与否无关。min-height 锁到当前最大子元素（22×22 操作
      按钮）高度。详见 electron/services/agent/SPEC.md §"任务完成尾注尺寸恒定"
      改动前必读，否则会重新引入 4dad4969 修复过的"任务完成时整屏上下闪烁"。
      入场动画用 opacity + translateY（compositor 层属性），不影响 box height，
      不破坏 item size 恒定不变量。 */
.agent-final-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-left: 2px;
  min-height: 22px;
  font-size: 11px;
  color: var(--text-muted);
}

.agent-final-footer--first-show {
  animation: agent-final-footer-enter 320ms cubic-bezier(0.32, 0.72, 0, 1) both;
}

@keyframes agent-final-footer-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.agent-final-footer-icon {
  color: var(--color-success);
  font-weight: 600;
}

/* group 操作菜单触发器（「...」图标按钮）：参照 Cursor 设计，平时极不起眼 */
.agent-group-menu-trigger {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  opacity: 0.35;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}

/* 鼠标 hover 到尾注/卡片任意位置时，按钮淡入显现 */
.agent-final-footer:hover .agent-group-menu-trigger,
.agent-final-content:hover .agent-group-menu-trigger {
  opacity: 0.7;
}

.agent-group-menu-trigger:hover,
.agent-group-menu-trigger.is-open {
  opacity: 1;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

/* 失败/中断卡片内的菜单容器：和卡片正文同样的左右内边距 */
.agent-final-footer--in-card {
  padding: 0 14px 12px;
  margin-top: 0;
  display: flex;
  justify-content: flex-end;
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

/* message step 的"思考块 + 正文"垂直栈：用 flex gap 接管两者间距，
   彻底消除原本依赖 margin collapse（思考块 +4 + 正文 -4 = 0）的不稳定布局。
   流式 → 完成切换时 marked 渲染节点变化会让 collapse 条件失效引起 ~4px 跳变，
   gap 与 margin collapse 互不干涉，间距永远恒定。 */
.agent-message-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.agent-message-stack > .step-text.step-analysis {
  margin: 0;
}

.agent-message-stack :deep(.thinking-block) {
  margin: 0;
}

/* footer 自身的 margin-top: 6px 在 stack 内会和 gap 叠加；让 stack gap 接管 */
.agent-message-stack > .agent-final-footer {
  margin-top: 0;
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
  border-left: 3px solid var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.1);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
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
  color: rgba(var(--brand-vital-rgb), 0.85);
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

/* tool_call 步骤的 content（如「执行命令: kill ...\nsleep 1\n...」）走纯文本渲染，
   不经过 markdown，所以这里只负责保留原文的换行和缩进，不做任何加粗/标题样式。 */
.step-text.tool-call-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* tool_call 内被 ToolCallContent 自动识别出的外部 URL 链接：与 markdown-content
   里同名样式的视觉保持一致（accent 色 + 悬停下划线），只是作用域不同。 */
.step-text.tool-call-content :deep(a.external-url-link) {
  cursor: pointer;
  color: var(--accent-primary);
  text-decoration: none;
  word-break: break-all;
}

.step-text.tool-call-content :deep(a.external-url-link:hover) {
  text-decoration: underline;
}

.agent-step-inline.error {
  color: var(--color-error);
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
  background: var(--chat-user-supplement-bubble-bg);
  color: var(--chat-user-bubble-color, var(--text-primary));
  border: 1px solid var(--chat-user-bubble-border);
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
  background: rgba(var(--color-info-rgb), 0.1);
  border-left: 3px solid var(--color-info);
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.waiting .step-icon {
  color: var(--color-info);
}

.agent-step-inline.asking {
  background: rgba(var(--accent-rgb), 0.08);
  border-left: 3px solid var(--accent-primary);
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.asking .step-icon {
  color: var(--accent-primary);
}

.agent-step-inline.waiting_password {
  background: rgba(var(--color-warning-rgb), 0.12);
  border-left: 3px solid var(--color-warning);
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
  animation: password-pulse 2s ease-in-out infinite;
}

.agent-step-inline.waiting_password .step-icon {
  color: var(--color-warning);
  animation: key-bounce 1s ease-in-out infinite;
}

@keyframes password-pulse {
  0%, 100% { 
    background: rgba(var(--color-warning-rgb), 0.12);
    border-left-color: var(--color-warning);
  }
  50% { 
    background: rgba(var(--color-warning-rgb), 0.2);
    border-left-color: var(--color-warning);
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
  color: var(--brand-vital);
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
  background: rgba(var(--accent-rgb), 0.06);
  border: 1px solid rgba(var(--accent-rgb), 0.2);
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
  background: rgba(var(--accent-rgb), 0.12);
  border-color: rgba(var(--accent-rgb), 0.35);
}

.asking-option-btn:active:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.18);
}

.asking-option-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-option-btn.clicking {
  background: rgba(var(--accent-rgb), 0.2);
  border-color: rgba(var(--accent-rgb), 0.5);
  color: var(--accent-primary);
}

.asking-option-btn.clicking .option-label {
  background: rgba(var(--accent-rgb), 0.3);
  color: var(--accent-primary);
}

.asking-option-btn.selected {
  background: rgba(var(--brand-vital-rgb), 0.12);
  border-color: rgba(var(--brand-vital-rgb), 0.35);
  color: var(--brand-vital);
}

.asking-option-btn.selected .option-label {
  background: rgba(var(--brand-vital-rgb), 0.25);
  color: var(--brand-vital);
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
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--color-info) 100%);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.asking-confirm-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent-secondary) 0%, var(--accent-primary) 100%);
  box-shadow: 0 2px 8px rgba(var(--color-info-rgb), 0.35);
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
  color: var(--color-success);
}

.asking-status.status-timeout {
  color: var(--color-warning);
}

.asking-status.status-cancelled {
  color: var(--color-error);
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

/* ==================== Web 搜索结果（精简：无卡片/无摘要，只保留标题+域名） ==================== */

.web-search-content {
  color: var(--text-muted);
}

.web-search-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.web-search-header:hover .web-search-summary,
.web-search-header:hover .web-search-expand-icon {
  color: var(--text-primary);
}

.web-search-summary {
  color: var(--text-muted);
}

.web-search-expand-icon {
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.web-search-expand-icon.expanded {
  transform: rotate(90deg);
}

.web-search-list {
  list-style: none;
  margin: 4px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.web-search-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.web-search-link {
  color: var(--color-info, #4dabf7);
  text-decoration: none;
  word-break: break-word;
  min-width: 0;
  flex-shrink: 1;
}

.web-search-link:hover {
  text-decoration: underline;
}

.web-search-host {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
  white-space: nowrap;
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
  border-color: rgba(var(--color-info-rgb), 0.4);
}

.sub-agent-card.completed {
  border-color: rgba(var(--color-success-rgb), 0.3);
}

.sub-agent-card.failed {
  border-color: rgba(var(--color-error-rgb), 0.3);
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
  color: var(--color-info);
  animation: sa-spin 1.2s linear infinite;
}

.sa-icon-completed {
  color: var(--color-success);
}

.sa-icon-failed {
  color: var(--color-error);
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
  color: var(--color-info);
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
  color: var(--color-info);
}

.sub-agent-card.completed .sub-agent-status-text {
  color: var(--color-success);
}

.sub-agent-card.failed .sub-agent-status-text {
  color: var(--color-error);
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

.sa-step-running { color: var(--color-info); }
.sa-step-done { color: var(--color-success); }
.sa-step-fail { color: var(--color-error); }

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
  color: var(--color-error);
}



/* 风险等级颜色 */
.risk-safe {
  border-left: 3px solid var(--color-success);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-moderate {
  border-left: 3px solid var(--color-warning);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-dangerous {
  border-left: 3px solid var(--color-error);
  padding-left: 10px;
  margin-left: -2px;
}

/* 预创建的 tool_call 卡片还没拿到 riskLevel 时的占位：保持和 risk-* 同样的几何尺寸
   （3px 左边框 + 10px 内边距 + -2px 外边距），颜色选用中性边线色。执行器接管后会被
   getRiskClass(riskLevel) 覆写为正式的 safe/moderate/dangerous 颜色，位置完全不动。 */
.risk-pending {
  border-left: 3px solid var(--border-color);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-blocked {
  border-left: 3px solid #6b7280;
  padding-left: 10px;
}

/* 执行结果色 —— 仅 tool_call 步骤使用。
   红=执行失败、绿=执行成功，和风险等级（确认对话框里的红/黄/绿）视觉完全解耦：
   风险色只在"等待用户确认"时出现，执行后的卡片只看结果。 */
.exec-failed {
  border-left: 3px solid var(--color-error);
  padding-left: 10px;
  margin-left: -2px;
}

.exec-success {
  border-left: 3px solid var(--color-success);
  padding-left: 10px;
  margin-left: -2px;
}

/* 拒绝执行的步骤：走灰色 + 半透明，和"失败红"在视觉上区分开。
   注意：这里 border-left 色故意不用 --color-error，避免"拒绝"看起来像"失败"。 */
.step-rejected {
  opacity: 0.6;
  border-left: 3px solid #6b7280 !important;
  padding-left: 10px;
  margin-left: -2px;
}

/* Agent 确认对话框（融入对话） */
.agent-confirm-inline {
  padding: 14px;
  border-radius: 10px;
}

/* ===== 高风险 - 红色系 ===== */
.agent-confirm-inline.risk-dangerous {
  background: linear-gradient(135deg, #3b1018 0%, #2a0a10 100%) !important;
  border: 2px solid var(--color-error) !important;
  box-shadow: 0 4px 20px rgba(var(--color-error-rgb), 0.2);
}

/* ===== 中风险 - 警示橙（走 --brand-caution，跨主题固定醒目橙黄，与高/低风险强弱阶梯对齐） ===== */
.agent-confirm-inline.risk-moderate {
  background: linear-gradient(135deg, #3d2810 0%, #2a1a08 100%) !important;
  border: 2px solid var(--brand-caution) !important;
  box-shadow: 0 4px 20px rgba(var(--brand-caution-rgb), 0.2);
}

/* ===== 低风险 - 绿色系（走 --brand-vital，跨主题固定活力绿） ===== */
.agent-confirm-inline.risk-safe {
  background: linear-gradient(135deg, #0f2920 0%, #081a14 100%) !important;
  border: 2px solid var(--brand-vital) !important;
  box-shadow: 0 4px 20px rgba(var(--brand-vital-rgb), 0.15);
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
  background: var(--color-error);
  color: #fff;
}

.confirm-risk-badge.risk-moderate {
  background: var(--brand-caution);
  color: #000;
}

.confirm-risk-badge.risk-safe {
  background: var(--brand-vital);
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
  background: var(--color-warning);
  border: 1px solid var(--color-warning);
  color: #000;
}

.btn-warning:hover:not(:disabled) {
  background: var(--color-warning);
  border-color: var(--color-warning);
}

/* 强警示按钮（删除/自由模式开启等不可逆操作）—— 走 --brand-alert */
.btn-danger {
  background: var(--brand-alert);
  border: 1px solid var(--brand-alert);
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: var(--brand-alert-end);
  border-color: var(--brand-alert-end);
}

/* 低风险允许执行按钮 —— 走 --brand-vital，跨主题固定活力绿
   （AiPanel scoped，仅作用于 Agent 确认卡片内的"允许执行"按钮） */
.btn-success {
  background: var(--brand-vital);
  border: 1px solid var(--brand-vital);
  color: #fff;
}

.btn-success:hover:not(:disabled) {
  background: var(--brand-vital-end);
  border-color: var(--brand-vital-end);
}

/* Outline 按钮样式（用于"始终允许"） */
.btn-outline-warning {
  background: transparent;
  border: 1px solid var(--color-warning);
  color: var(--color-warning);
}

.btn-outline-warning:hover:not(:disabled) {
  background: rgba(var(--color-warning-rgb), 0.15);
  color: var(--color-warning);
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid var(--color-error);
  color: var(--color-error);
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.15);
  color: var(--color-error);
}

/* "始终允许"按钮 —— 走 --brand-vital，与低风险信号保持一致 */
.btn-outline-success {
  background: transparent;
  border: 1px solid var(--brand-vital);
  color: var(--brand-vital);
}

.btn-outline-success:hover:not(:disabled) {
  background: rgba(var(--brand-vital-rgb), 0.15);
  color: var(--brand-vital);
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
  border: 2px solid rgba(var(--accent-rgb), 0.2);
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

/* 「活图」预览容器：width / height 由 previewEchartsBoxStyle (JS) 内联提供。
 *
 * 不能纯靠 CSS 实现 contain 进 90vw × 90vh：父容器 .image-preview-modal-content
 * 是 max-content sizing，没有具体 width；子组件 EChartsCanvas 又得 width:100%
 * 才能跟随。两边互相依赖会塌陷为 0×0（曾经踩过这个坑——大图打不开就是这个原因）。
 *
 * 现在父容器拿到 JS 算好的具体像素，子元素 100%/100% 跟随，echarts 内部 ResizeObserver
 * 在 winSize 变化时自动 resize，没有 aspect-ratio 重复约束的边界 case。
 */
.image-preview-echarts {
  border-radius: 8px;
  cursor: grab;
  transform-origin: center center;
  transition: none;
  user-select: none;
  background: var(--bg-primary, #1a1a1a);
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden;
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

<!-- 全局样式：菜单通过 Teleport 渲染到 body，scoped 样式不会作用到它，需要单独的非 scoped block -->
<style>
.agent-group-menu {
  position: fixed;
  min-width: 140px;
  padding: 4px;
  background: var(--bg-elevated, rgba(40, 40, 40, 0.98));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 10000;
}

.agent-group-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-primary, #e0e0e0);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.agent-group-menu-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.agent-group-menu-item:disabled {
  cursor: progress;
  opacity: 0.5;
  pointer-events: none;
}
</style>
