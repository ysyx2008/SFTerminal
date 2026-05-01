/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 * 同时管理 AI 面板的滚动和终端状态
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { useCanvasStore } from '../stores/canvas'
import type { ExecutionMode, AttachmentInfo } from '@shared/types'
import type { AgentStep, AgentState } from '../stores/terminal'
import { createLogger } from '../utils/logger'
import { useTts } from './useTts'
import { shouldShowToolResultStep } from '../utils/tool-display'

const log = createLogger('Agent')

function getLocalSystemInfo() {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('win')) {
    return { os: 'windows', shell: 'powershell', description: '' }
  } else if (platform.includes('mac')) {
    return { os: 'macos', shell: 'zsh', description: '' }
  }
  return { os: 'linux', shell: 'bash', description: '' }
}

const SCROLL_THRESHOLD = 100
const SCROLL_THROTTLE_MS = 1000

export interface AgentTaskGroup {
  id: string
  userTask: string
  images?: string[]
  attachments?: AttachmentInfo[]
  steps: AgentStep[]
  finalResult?: string
  isCurrentTask: boolean
  isProactive?: boolean
  isOnboarding?: boolean
}

export interface VirtualItem {
  id: string
  type: 'user_task' | 'step' | 'final_result' | 'proactive_message' | 'confirm'
  group?: AgentTaskGroup
  step?: AgentStep
  content?: string
  size: number
  isFirstStep?: boolean
}

export function useAgentMode(
  messagesRef: Ref<HTMLDivElement | null>,
  getDocumentContext: () => Promise<string>,
  getHostIdByTabId: (tabId: string) => Promise<string>,  // 根据 tabId 获取 hostId（不依赖 activeTab）
  autoProbeHostProfile: () => Promise<void>,
  tabId: Ref<string>,  // 每个 AiPanel 实例固定绑定的 tab ID
  imageCallbacks?: {
    getImages: () => string[]          // 全部图片（传给 AI 视觉模型）
    getPreviewImages?: () => string[]  // UI 展示用的预览图（仅 PDF 页面渲染），默认同 getImages
    clearImages: () => void
  },
  attachmentCallbacks?: {
    getAttachments: () => AttachmentInfo[]  // 获取当前已上传文件的元信息
    clearAttachments: () => void            // 清空已上传文件列表
  }
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const configStore = useConfigStore()
  const canvasStore = useCanvasStore()
  const tts = useTts()
  if (configStore.ttsSettings.enabled && configStore.ttsSettings.autoSpeak) {
    tts.isEnabled.value = true
  }

  // 当前终端 ID（使用传入的 tabId，不再依赖 activeTabId）
  const currentTabId = tabId

  // ==================== 输入和滚动状态 ====================
  
  // 输入文本
  const inputText = ref('')

  // 队列化的 proactive 回复：agent 忙且有延迟 proactive 消息时暂存，任务完成后作为新任务启动
  const queuedProactiveReply = ref<string | null>(null)
  
  // 是否有新消息（用户不在底部时显示提示）
  const hasNewMessage = ref(false)
  
  // 标志：是否跳过 scroll 事件的状态更新（用于避免强制滚动时被 scroll 事件覆盖）
  let skipScrollUpdate = false
  
  // 智能滚动节流状态
  let scrollPending = false
  let lastScrollTime = 0

  // Agent 执行模式设置
  const executionMode = ref<ExecutionMode>('relaxed')
  const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
  const activeProfileId = ref<string>(configStore.activeAiProfileId || '')  // 当前终端选择的 AI 配置档案 ID（每个终端独立，初始值继承全局设置）
  const collapsedTaskIds = ref<Set<string>>(new Set())  // 已折叠的任务 ID

  // 清理事件监听的函数
  let cleanupStepListener: (() => void) | null = null
  let cleanupStepRemovedListener: (() => void) | null = null
  let cleanupConfirmListener: (() => void) | null = null
  let cleanupConfirmResolvedListener: (() => void) | null = null
  let cleanupCompleteListener: (() => void) | null = null
  let cleanupErrorListener: (() => void) | null = null

  // 获取当前 tab（基于固定的 tabId）
  const currentTab = computed(() => {
    return terminalStore.tabs.find(t => t.id === currentTabId.value)
  })

  const isStandaloneAssistant = computed(() => currentTab.value?.type === 'assistant')

  // ==================== 终端状态 ====================
  
  // 当前终端的 AI 加载状态（每个终端独立）
  const isLoading = computed(() => {
    return currentTab.value?.aiLoading || false
  })

  // 获取当前终端的系统信息
  const currentSystemInfo = computed(() => {
    const tab = currentTab.value
    if (tab?.systemInfo) {
      return tab.systemInfo
    }
    return null
  })

  // 获取当前终端选中的文本
  const terminalSelectedText = computed(() => {
    return currentTab.value?.selectedText || ''
  })

  // 获取最近的错误
  const lastError = computed(() => {
    return currentTab.value?.lastError
  })

  // ==================== 滚动相关 ====================
  
  // 用户是否在底部附近（从 store 获取，每个终端独立）
  const isUserNearBottom = computed(() => {
    const id = currentTabId.value
    if (!id) return true
    return terminalStore.getAiScrollNearBottom(id)
  })

  // 设置当前 tab 的 isUserNearBottom 状态
  const setIsUserNearBottom = (value: boolean) => {
    const id = currentTabId.value
    if (id) {
      terminalStore.setAiScrollNearBottom(id, value)
    }
  }

  // 检查用户是否在底部附近
  const checkIsNearBottom = () => {
    if (!messagesRef.value) return true
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.value
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return
    const nearBottom = checkIsNearBottom()
    setIsUserNearBottom(nearBottom)
    // 如果用户滚动到底部，清除新消息提示
    if (nearBottom) {
      hasNewMessage.value = false
    }
  }

  // 强制滚动到底部（用户主动发送消息或点击时调用）
  const scrollToBottom = async () => {
    // 先设置状态，防止被 scroll 事件覆盖
    skipScrollUpdate = true
    setIsUserNearBottom(true)
    hasNewMessage.value = false
    
    await nextTick()
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
    
    // 延迟恢复 scroll 事件更新，确保滚动完成后才开始监听用户滚动
    requestAnimationFrame(() => {
      skipScrollUpdate = false
    })
  }

  // 实际执行滚动
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    // 跳过 DynamicScroller 因布局调整触发的 scroll 事件，防止干扰 isUserNearBottom 状态
    skipScrollUpdate = true
    await nextTick()
    
    // 仅依赖 isUserNearBottom（由用户真实滚动事件维护）
    // 不做实时 checkIsNearBottom()：DynamicScroller 的 scrollHeight 基于估算，
    // 虚拟化的 off-screen 项高度远小于实际值，会导致误判"在底部附近"
    if (isUserNearBottom.value) {
      if (messagesRef.value) {
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        
        messagesRef.value.scrollTop = messagesRef.value.scrollHeight
      }
    } else {
      hasNewMessage.value = true
    }
    
    // 延迟恢复 scroll 事件监听，等待 DynamicScroller 布局稳定
    setTimeout(() => {
      skipScrollUpdate = false
    }, 80)
  }

  // 智能滚动：只有用户在底部附近时才自动滚动（带节流）
  const scrollToBottomIfNeeded = async () => {
    const now = Date.now()
    
    // 节流：如果距离上次滚动时间过短，标记为待处理
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) {
      if (!scrollPending) {
        scrollPending = true
        requestAnimationFrame(() => {
          scrollPending = false
          doScrollIfNeeded()
        })
      }
      return
    }
    
    await doScrollIfNeeded()
  }

  // 停止生成
  const stopGeneration = async () => {
    if (currentTabId.value) {
      // 传入 tabId 只中止当前终端的请求，不影响其他终端
      await window.electronAPI.ai.abort(currentTabId.value)
      terminalStore.setAiLoading(currentTabId.value, false)
    }
  }

  // Agent 状态
  const agentState = computed((): AgentState | undefined => {
    return currentTab.value?.agentState as AgentState | undefined
  })

  const isAgentRunning = computed(() => {
    return agentState.value?.isRunning || false
  })

  const pendingConfirm = computed(() => {
    return agentState.value?.pendingConfirm
  })

  const agentUserTask = computed(() => {
    return agentState.value?.userTask
  })

  // 当前执行计划 - 从 steps 中提取最新的 plan
  const currentPlan = computed((): AgentPlan | undefined => {
    const steps = agentState.value?.steps || []
    // 倒序查找最新的 plan 相关步骤
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      // 如果遇到 plan_archived，说明计划已被归档，当前无活跃计划
      if (step.type === 'plan_archived') {
        return undefined
      }
      // 如果遇到 plan_created 或 plan_updated 且有 plan 数据
      if ((step.type === 'plan_created' || step.type === 'plan_updated') && step.plan) {
        return step.plan as AgentPlan
      }
    }
    return undefined
  })

  // 切换任务步骤折叠状态
  const toggleStepsCollapse = (taskId: string) => {
    if (collapsedTaskIds.value.has(taskId)) {
      collapsedTaskIds.value.delete(taskId)
    } else {
      collapsedTaskIds.value.add(taskId)
    }
  }

  // 检查任务是否折叠
  const isStepsCollapsed = (taskId: string) => {
    return collapsedTaskIds.value.has(taskId)
  }

  // 获取当前 tab 对应的 Agent 标识符。
  //
  // ⚠️ 终端模式下必须返回 Agent 启动时绑定的 ptyId（保存在 agentState.agentId 上），
  //    而不是"当前激活窗格 ptyId"。后端 AgentService 用 ptyId 在 Map 里索引 Agent 实例，
  //    分屏 / focus_pane 之后激活窗格会变化，但 Agent 实例的 key 不能跟着变——
  //    否则 addUserMessage / abort / confirm 都会找不到 Agent 实例（间歇性"补充消息无响应"bug）。
  //
  // 任务未启动时 fallback 到当前激活窗格 ptyId，方便未来一键启动新任务时识别 tab。
  const getAgentKey = (): string | undefined => {
    const tab = currentTab.value
    if (!tab) return undefined
    if (tab.type === 'assistant') return tab.agentId
    return tab.agentState?.agentId || terminalStore.getActivePtyId(tab)
  }

  // 监听执行模式变化，实时更新运行中的 Agent
  watch(executionMode, async (newValue) => {
    const promises: Promise<unknown>[] = []

    // 远程 tab：同步到 WebChatService（运行时覆盖，不持久化）
    if (currentTab.value?.isRemote) {
      promises.push(
        window.electronAPI.webChat.setExecutionMode(newValue).catch(err => {
          log.error('Failed to sync execution mode to WebChatService:', err)
        })
      )
    }

    const key = getAgentKey()
    if (key && isAgentRunning.value) {
      promises.push(
        window.electronAPI.agent.updateConfig(key, { executionMode: newValue })
      )
    }

    await Promise.all(promises)
  })

  // 监听超时设置变化
  watch(commandTimeout, async (newValue) => {
    const key = getAgentKey()
    if (key && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(key, { commandTimeout: newValue * 1000 })
    }
  })

  // 监听模型配置变化，实时同步到运行中的 Agent
  watch(activeProfileId, async (newValue) => {
    const key = getAgentKey()
    if (key && isAgentRunning.value && newValue) {
      await window.electronAPI.agent.updateConfig(key, { profileId: newValue })
    }
  })

  // 按任务分组的步骤（每个任务包含：用户任务 + 步骤块 + 最终结果）
  const agentTaskGroups = computed((): AgentTaskGroup[] => {
    const allSteps = agentState.value?.steps || []
    const groups: AgentTaskGroup[] = []
    let currentGroup: AgentTaskGroup | null = null
    let orphanedStepCount = 0
    
    for (const step of allSteps) {
      if (step.type === 'user_task') {
        const isProactive = step.content === '__proactive__'
        const isOnboarding = step.content === '__onboarding__'
        currentGroup = {
          id: step.id,
          userTask: (isProactive || isOnboarding) ? '' : step.content,
          images: step.images,
          attachments: step.attachments,
          steps: [],
          isCurrentTask: false,
          isProactive,
          isOnboarding,
        }
        groups.push(currentGroup)
      } else if (step.type === 'final_result') {
        if (currentGroup) {
          currentGroup.finalResult = step.content
          currentGroup = null
        }
      } else if (step.type !== 'confirm') {
        if (currentGroup) {
          currentGroup.steps.push(step)
        } else {
          orphanedStepCount++
        }
      }
    }
    
    // 标记最后一个未完成的任务为当前任务
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1]
      if (!lastGroup.finalResult) {
        lastGroup.isCurrentTask = true
      }
    }

    
    // 不再删除"跟 finalResult 重复"的最后一个 message step：
    // 现在 message step 始终保留完整内容（思考块 + 正文），成功的 final_result 不再单独渲染卡片，
    // 删除 message step 反而会让正文连同思考块一起消失。失败/中断的 final_result 才独立成卡。
    
    // 诊断日志：仅在远程 tab 且有变化时打印
    const tab = currentTab.value
    if (tab?.isRemote) {
      const stepTypes = allSteps.map(s => s.type)
      const userTaskCount = stepTypes.filter(t => t === 'user_task').length
      const finalResultCount = stepTypes.filter(t => t === 'final_result').length
      log.debug(`[Groups] tabId=${tab.id}, totalSteps=${allSteps.length}, groups=${groups.length}, userTasks=${userTaskCount}, finals=${finalResultCount}, orphaned=${orphanedStepCount}, stepTypes=[${stepTypes.join(',')}]`)
    }
    
    return groups
  })

  const isStreamingOutput = (group: AgentTaskGroup): boolean => {
    if (group.steps.length === 0) return false
    const lastStep = group.steps[group.steps.length - 1]
    if (lastStep.type === 'message' && (lastStep.isStreaming || lastStep.content.length > 0)) {
      return true
    }
    if (lastStep.type === 'waiting' || lastStep.type === 'asking' || lastStep.type === 'waiting_password') {
      return true
    }
    return false
  }

  const flattenedItems = computed((): VirtualItem[] => {
    const items: VirtualItem[] = []

    for (const group of agentTaskGroups.value) {
      if (group.isProactive) {
        if (group.finalResult) {
          items.push({ id: `proactive_${group.id}`, type: 'proactive_message', group, size: 80 })
        }
        continue
      }

      if (!group.isOnboarding) {
        items.push({ id: `user_${group.id}`, type: 'user_task', group, size: 60 })
      }

      // 初始等待提示由后端以 thinking step（"正在准备..."）承载，前端不再额外插入虚拟项

      if (group.steps.length > 0) {
        // 调试模式 OFF 时，隐藏"成功且无用户必看产出"的 tool_call / tool_result step
        // （详见 utils/tool-display.ts）。失败 / 写入类 / 携带富内容字段（图片、搜索结果、
        // 子 Agent）的 step 永远展示；专用 step type 工具（plan/ask_user/wait）的双卡也会
        // 一并隐藏，让位给专用卡。
        const debugMode = configStore.agentDebugMode
        const visibleSteps = group.steps.filter(s => shouldShowToolResultStep(s, debugMode))
        for (let i = 0; i < visibleSteps.length; i++) {
          const step = visibleSteps[i]
          const isFirst = i === 0
          const size = step.type === 'message'
            ? Math.max(80, Math.ceil(step.content.length / 4))
            : step.type === 'asking' ? 120 : isFirst ? 46 : 40
          items.push({ id: step.id, type: 'step', step, group, size, isFirstStep: isFirst })
        }
      }

      if (group.finalResult) {
        // 失败 / 中断的 final_result 才作为独立卡片渲染（包含错误信息）；
        // 成功的 final_result 不再渲染——message step 已经完整呈现思考块 + 正文，
        // 独立"任务完成"卡反而会引起列表跳动。
        const isFailureFinal = group.finalResult.startsWith('❌') || group.finalResult.startsWith('⚠️')
        if (isFailureFinal) {
          // 若 group 没有其它步骤（典型的纯对话场景），让 final_result 承担"首条"标识，
          // 以便渲染 standalone 头像，避免从流式 → 完成时头像消失
          items.push({ id: `final_${group.id}`, type: 'final_result', group, size: 80, isFirstStep: group.steps.length === 0 })
        }
      }
    }

    if (pendingConfirm.value) {
      items.push({ id: '__confirm__', type: 'confirm', size: 280 })
    }

    return items
  })

  // 保存当前会话（供外部调用，如清空对话时）
  // 注意：会话历史现在由后端 Agent 在 finalizeRun 时自动保存到 HistoryService
  // 此方法保留接口但不再执行操作，避免前端重复保存
  const saveCurrentSession = () => {
    // 后端已在每次 run 结束时自动保存，无需前端再次保存
  }

  // 运行 Agent 或发送补充消息
  const runAgent = async (overrideMessage?: string) => {
    const hasImageData = (imageCallbacks?.getImages()?.length ?? 0) > 0
    const message = overrideMessage ?? inputText.value
    if ((!message.trim() && !hasImageData) || !currentTabId.value) return

    const tabId = currentTabId.value

    const isAssistantMode = currentTab.value?.type === 'assistant'

    // 如果 Agent 正在运行，发送补充消息而不是启动新任务
    // 用 getAgentKey() 拿 Agent 启动时绑定的稳定 key（不随激活窗格变化）
    const agentKey = getAgentKey()
    if (isAgentRunning.value && agentKey) {
      // 安全兜底：如果 tab 有延迟的 proactive 通知，用户此时的回复可能是对通知的回应
      // 队列化等待当前任务完成后再作为新任务启动（由 consumeProactiveContext 自动注入上下文）
      if (terminalStore.hasDeferredProactive(tabId)) {
        inputText.value = ''
        queuedProactiveReply.value = message
        await scrollToBottom()
        return
      }

      inputText.value = ''
      
      // 收集附件元信息、文档内容、图片（与新任务路径对齐）
      const supplementAttachments = attachmentCallbacks?.getAttachments() || []
      const documentContext = await getDocumentContext()
      const images = imageCallbacks?.getImages() || []
      
      const success = await window.electronAPI.agent.addMessage(
        agentKey,
        message,
        supplementAttachments.length > 0 ? supplementAttachments : undefined,
        documentContext || undefined,
        images.length > 0 ? images : undefined
      )
      
      if (success) {
        if (supplementAttachments.length > 0) attachmentCallbacks?.clearAttachments()
        if (images.length > 0) imageCallbacks?.clearImages()
      }
      return
    }

    const startTime = Date.now()
    inputText.value = ''

    // 新任务开始，重置 TTS（会停止旧播报）
    if (tts.isEnabled.value) {
      tts.startNewTask()
    }

    // 获取 Agent 上下文
    const context = isAssistantMode
      ? { mode: 'single' as const, terminalOutput: [] as string[], systemInfo: getLocalSystemInfo() } as any
      : terminalStore.getAgentContext(tabId)
    // 终端模式下 ptyId 必须存在（分屏取激活窗格，单屏取 tab.ptyId）
    const runPtyId = isAssistantMode
      ? undefined
      : (currentTab.value ? terminalStore.getActivePtyId(currentTab.value) : undefined)
    if (!isAssistantMode && (!context || !runPtyId)) {
      log.error('无法获取终端上下文')
      return
    }
    // 并行获取异步上下文，减少等待时间
    const [hostId, documentContext] = await Promise.all([
      getHostIdByTabId(tabId),
      getDocumentContext()
    ])

    // 首次运行时自动探测主机信息（后台执行，不阻塞）
    autoProbeHostProfile().catch(e => {
      log.warn('主机探测失败:', e)
    })

    // 准备新任务（保留之前的步骤）
    terminalStore.clearAgentState(tabId, true)
    
    // 如果是新会话（没有 sessionId），设置会话 ID 和开始时间
    if (!agentState.value?.sessionId) {
      terminalStore.setAgentSession(tabId, `session_${startTime}`, startTime)
    }
    
    // 获取图片：全部图片传给 AI，预览图片存入步骤供 UI 展示
    const images = imageCallbacks?.getImages() || []
    const previewImages = imageCallbacks?.getPreviewImages?.() || images

    if (images.length > 0) {
      imageCallbacks?.clearImages()
    }

    // 获取当前已上传文件的元信息（用于 user_task 步骤展示）
    const attachments = attachmentCallbacks?.getAttachments() || []

    // 清空已上传的文件列表
    if (attachments.length > 0) {
      attachmentCallbacks?.clearAttachments()
    }

    // 设置 Agent 状态：正在运行 + 用户任务。
    // 第三个参数 agentId 必须传——它在 agentState 上记录 Agent 启动时的稳定 key，
    // 后续的 addUserMessage / abort / confirm 都通过 getAgentKey() 拿到这个 key，
    // 保证分屏 / focus_pane 改变激活窗格时仍能定位到正确的 Agent 实例。
    const stableAgentKey = isAssistantMode
      ? currentTab.value?.agentId
      : runPtyId
    terminalStore.setAgentRunning(tabId, true, stableAgentKey, message)
    await scrollToBottom()

    try {
      // 根据模式选择 API
      let result: { success: boolean; result?: string; error?: string; aborted?: boolean }
      
      if (isAssistantMode && currentTab.value?.agentId) {
        result = await window.electronAPI.agent.runStandalone(
          currentTab.value.agentId,
          message,
          {
            ...context,
            hostId,
            documentContext,
            images: images.length > 0 ? images : undefined,
            previewImages: previewImages.length < images.length ? previewImages : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            remoteChannel: currentTab.value.remoteChannel,
            sessionId: agentState.value?.sessionId,
            sessionStartTime: agentState.value?.sessionStartTime
          },
          { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
          activeProfileId.value || undefined
        )
      } else {
        result = await window.electronAPI.agent.run(
          runPtyId as string,
          message,
          {
            ...context,
            hostId,
            sshHost: currentTab.value?.sshConfig?.host,
            documentContext,
            images: images.length > 0 ? images : undefined,
            previewImages: previewImages.length < images.length ? previewImages : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            sessionId: agentState.value?.sessionId,
            sessionStartTime: agentState.value?.sessionStartTime
          },
          { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
          activeProfileId.value || undefined
        )
      }
      // 后端已通过 onStep 推送 final_result，这里只需设置 finalResult 状态
      if (!result.success) {
        const finalContent = result.aborted
          ? t('ai.taskAbortedMessage')
          : t('ai.agentExecutionFailed', { error: result.error })
        terminalStore.setAgentFinalResult(tabId, finalContent)
      } else if (result.result) {
        terminalStore.setAgentFinalResult(tabId, result.result)
      }
    } catch (error) {
      log.error('Agent 运行失败:', error)
      const errorMessage = error instanceof Error ? error.message : t('ai.unknownError')
      const finalContent = t('ai.agentRunError', { error: errorMessage })
      
      // IPC 层面的错误（如连接断开），后端可能没来得及推送 final_result
      // 检查后端是否已推送过 final_result，避免重复
      const currentSteps = agentState.value?.steps || []
      if (!currentSteps.some(s => s.type === 'final_result')) {
        terminalStore.addAgentStep(tabId, {
          id: `final_result_${Date.now()}`,
          type: 'final_result',
          content: finalContent,
          timestamp: Date.now()
        })
      }
      terminalStore.setAgentFinalResult(tabId, finalContent)
    } finally {
      terminalStore.setAgentRunning(tabId, false)
    }

    // 完成后使用智能滚动
    await scrollToBottomIfNeeded()
  }

  const abortAgent = async () => {
    tts.stop()
    const agentKey = getAgentKey()
    if (!agentKey) return

    try {
      await window.electronAPI.agent.abort(agentKey)
    } catch (error) {
      log.error('中止 Agent 失败:', error)
    }
  }

  // alwaysAllow: 如果为 true，将该工具+参数加入会话白名单，后续自动跳过确认
  const confirmToolCall = async (approved: boolean, alwaysAllow?: boolean) => {
    const confirm = pendingConfirm.value
    if (!confirm) return

    const agentKey = getAgentKey()
    if (!agentKey) return

    try {
      await window.electronAPI.agent.confirm({
        ptyId: agentKey,
        toolCallId: confirm.toolCallId,
        approved,
        modifiedArgs: undefined,
        alwaysAllow
      })
      // 清除待确认状态
      if (currentTabId.value) {
        terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
      }
    } catch (error) {
      log.error('确认工具调用失败:', error)
    }
  }

  // 发送 Agent 回复（用于用户点击选项快速回复）
  const sendAgentReply = async (message: string) => {
    if (!message.trim() || !currentTabId.value) return

    const key = getAgentKey()
    if (!isAgentRunning.value || !key) return

    await window.electronAPI.agent.addMessage(key, message)
  }

  // 获取步骤类型的图标
  const getStepIcon = (type: AgentStep['type']): string => {
    switch (type) {
      case 'thinking': return '🤔'
      case 'tool_call': return '🔧'
      case 'tool_result': return '📋'
      case 'message': return '💬'
      case 'error': return '❌'
      case 'confirm': return '⚠️'
      case 'user_task': return '👤'
      case 'final_result': return '✅'
      case 'user_supplement': return '💡'
      case 'waiting': return '⏳'
      case 'asking': return '❓'
      case 'waiting_password': return '🔐'
      case 'plan_created': return '📋'
      case 'plan_updated': return '📋'
      case 'plan_archived': return '📦'
      default: return '•'
    }
  }

  // 获取风险等级的颜色类
  const getRiskClass = (riskLevel?: string): string => {
    switch (riskLevel) {
      case 'safe': return 'risk-safe'
      case 'moderate': return 'risk-moderate'
      case 'dangerous': return 'risk-dangerous'
      case 'blocked': return 'risk-blocked'
      default: return ''
    }
  }

  /**
   * 根据工具步骤的执行结果返回竖条样式类。
   * 仅用于 tool_call 步骤：把"风险色"替换为"执行结果色"，和确认对话框里的风险红/黄/绿视觉解耦。
   *   - success === false → 红色（exec-failed）
   *   - success === true  → 绿色（exec-success）
   *   - undefined         → 空串（由上游的 risk-pending/无色样式兜底表示"运行中"）
   */
  const getExecStatusClass = (step: AgentStep): string => {
    if (step.success === false) return 'exec-failed'
    if (step.success === true) return 'exec-success'
    return ''
  }

  // 设置 Agent 事件监听
  // 注意：每个 AiPanel 实例都会注册监听器，所以需要确保只处理属于自己 tab 的事件
  const setupAgentListeners = () => {
    // 先清理旧的监听器，防止热重载时重复注册
    cleanupAgentListeners()
    // 判断事件是否属于当前 tab（优先使用 ptyId 匹配，更可靠）
    const isEventForThisTab = (agentId: string, ptyId?: string): boolean => {
      // 优先使用 ptyId 匹配（最可靠，因为 ptyId 在启动前就已知）
      if (ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(ptyId)
        if (foundTabId === currentTabId.value) {
          // 确保 agentId 关联已设置
          terminalStore.setAgentId(currentTabId.value, agentId)
          return true
        }
        return false
      }
      
      // 降级：使用 agentId 匹配（兼容旧逻辑）
      const foundTabId = terminalStore.findTabIdByAgentId(agentId)
      if (foundTabId) {
        return foundTabId === currentTabId.value
      }
      
      // 最后的降级：检查当前 tab 是否正在等待 Agent 启动
      // 注意：这种情况在多 tab 同时启动时可能不可靠
      const currentState = agentState.value
      if (currentState?.isRunning && !currentState.agentId) {
        terminalStore.setAgentId(currentTabId.value, agentId)
        return true
      }
      
      return false
    }
    
    // 监听步骤更新
    cleanupStepListener = window.electronAPI.agent.onStep((data: { agentId: string; ptyId?: string; step: AgentStep; wakeup?: boolean }) => {
      // 唤醒模式的 step 只给 Awaken 面板，不进入对话记录
      if (data.wakeup) return
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      
      const tabId = currentTabId.value
      terminalStore.addAgentStep(tabId, data.step)

      // 独立助手模式下，驱动 Canvas 预览面板
      if (isStandaloneAssistant.value) {
        canvasStore.handleAgentStep(tabId, data.step)
      }

      // TTS: 流式 message / final_result 喂给语音合成（远程会话不播报）
      if (tts.isEnabled.value && configStore.ttsSettings.enabled && !currentTab.value?.isRemote) {
        if (data.step.type === 'message' && data.step.content) {
          tts.feedContent(data.step.content)
        } else if (data.step.type === 'final_result' && data.step.content) {
          tts.flush()
          tts.feedContent(data.step.content)
          tts.flush()
        } else {
          tts.flush()
        }
      }
      
      // 使用智能滚动，不打断用户查看历史
      scrollToBottomIfNeeded()
    })

    // 监听步骤移除（后端撤销临时占位步骤，如初始"正在准备..."）
    cleanupStepRemovedListener = window.electronAPI.agent.onStepRemoved((data: { agentId: string; ptyId?: string; stepId: string }) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.removeAgentStep(currentTabId.value, data.stepId)
    })

    // 监听需要确认
    cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
      // 类型转换，添加 ptyId 支持
      const eventData = data as { agentId: string; ptyId?: string; toolCallId: string; toolName: string; toolArgs: Record<string, unknown>; riskLevel: string }
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(eventData.agentId, eventData.ptyId)) return
      
      terminalStore.setAgentPendingConfirm(currentTabId.value, data)

      // TTS 播报确认请求
      if (tts.isEnabled.value && configStore.ttsSettings.enabled && !currentTab.value?.isRemote) {
        tts.flush()
        const args = eventData.toolArgs
        const risk = eventData.riskLevel === 'dangerous' ? '注意，这是高风险操作。'
          : eventData.riskLevel === 'moderate' ? '这是中等风险操作。'
          : ''
        let action = ''
        if (args.command) {
          action = `我需要执行 ${args.command}`
        } else if (args.path) {
          action = `我需要操作文件 ${args.path}`
        } else {
          action = '接下来的操作'
        }
        tts.feedContent(`${risk}${action}，请确认。`)
        tts.flush()
      }

      // 需要确认时强制滚动，确保用户看到确认框
      // 多次滚动：DynamicScroller 测量实际高度需要时间，首次滚动可能基于估算值
      scrollToBottom()
      setTimeout(() => scrollToBottom(), 150)
    })

    // 监听确认已被其他渠道处理（如 IM 端确认后清除桌面确认框）
    cleanupConfirmResolvedListener = window.electronAPI.agent.onConfirmResolved((data) => {
      const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
      if (foundTabId === currentTabId.value) {
        terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
      }
    })

    // 监听完成
    cleanupCompleteListener = window.electronAPI.agent.onComplete((data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: string[] }) => {
      // 只处理属于当前 tab 的事件（优先使用 ptyId 匹配）
      if (data.ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(data.ptyId)
        if (foundTabId !== currentTabId.value) return
      } else {
        const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
        if (foundTabId !== currentTabId.value) return
      }
      
      terminalStore.setAgentRunning(currentTabId.value, false)
      // 通知 Canvas 任务完成
      if (isStandaloneAssistant.value) {
        canvasStore.handleAgentComplete(currentTabId.value)
      }
      // 队列化的 proactive 回复优先：作为新任务启动（consumeProactiveContext 自动注入 Watch 上下文）
      if (queuedProactiveReply.value) {
        const reply = queuedProactiveReply.value
        queuedProactiveReply.value = null
        log.info('任务完成，启动队列中的 proactive 回复:', reply)
        setTimeout(() => {
          inputText.value = reply
          runAgent()
        }, 100)
        return
      }
      
      // 如果有未处理的用户消息（用户在 Agent 总结时发送的），自动作为新任务启动
      if (data.pendingUserMessages && data.pendingUserMessages.length > 0) {
        const pendingMessage = data.pendingUserMessages.join('\n')
        log.info('发现未处理的用户消息，将作为新任务启动:', pendingMessage)
        // 延迟一点启动，让当前完成状态先更新到 UI
        setTimeout(() => {
          inputText.value = pendingMessage
          runAgent()
        }, 100)
      }
    })

    // 监听错误
    cleanupErrorListener = window.electronAPI.agent.onError((data: { agentId: string; ptyId?: string; error: string }) => {
      // 只处理属于当前 tab 的事件（优先使用 ptyId 匹配）
      if (data.ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(data.ptyId)
        if (foundTabId !== currentTabId.value) return
      } else {
        const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
        if (foundTabId !== currentTabId.value) return
      }
      
      terminalStore.setAgentRunning(currentTabId.value, false)
      queuedProactiveReply.value = null
      terminalStore.addAgentStep(currentTabId.value, {
        id: `error_${Date.now()}`,
        type: 'error',
        content: data.error,
        timestamp: Date.now()
      })
    })
  }

  // 清理 Agent 事件监听
  const cleanupAgentListeners = () => {
    if (cleanupStepListener) {
      cleanupStepListener()
      cleanupStepListener = null
    }
    if (cleanupStepRemovedListener) {
      cleanupStepRemovedListener()
      cleanupStepRemovedListener = null
    }
    if (cleanupConfirmListener) {
      cleanupConfirmListener()
      cleanupConfirmListener = null
    }
    if (cleanupConfirmResolvedListener) {
      cleanupConfirmResolvedListener()
      cleanupConfirmResolvedListener = null
    }
    if (cleanupCompleteListener) {
      cleanupCompleteListener()
      cleanupCompleteListener = null
    }
    if (cleanupErrorListener) {
      cleanupErrorListener()
      cleanupErrorListener = null
    }
  }

  // ==================== 历史对话功能 ====================
  
  // 历史记录类型定义
  interface AgentRecord {
    id: string
    timestamp: number
    terminalId: string
    terminalType: 'local' | 'ssh'
    sshHost?: string
    userTask: string
    steps: Array<{
      id: string
      type: string
      content: string
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      riskLevel?: string
      timestamp: number
    }>
    finalResult?: string
    duration: number
    status: 'completed' | 'failed' | 'aborted'
  }

  // 近期历史记录（用于欢迎页展示）
  const recentHistory = ref<AgentRecord[]>([])
  const isLoadingHistory = ref(false)
  
  // 查看更多弹窗状态
  const showHistoryModal = ref(false)
  const allHistory = ref<AgentRecord[]>([])
  const isLoadingAllHistory = ref(false)
  const HISTORY_PAGE_SIZE = 20
  const hasMoreHistory = ref(true)

  // 加载近期历史（最近 5 条，用于欢迎页）
  const loadRecentHistory = async () => {
    if (isLoadingHistory.value) return
    isLoadingHistory.value = true
    try {
      const records = await window.electronAPI.history.getRecentAgentRecords(5, true) as AgentRecord[]
      recentHistory.value = records.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
    } catch (e) {
      log.error('加载历史记录失败:', e)
    } finally {
      isLoadingHistory.value = false
    }
  }

  // 分页加载历史（用于弹窗）
  const loadAllHistory = async (reset = true) => {
    if (isLoadingAllHistory.value) return
    isLoadingAllHistory.value = true
    try {
      const currentCount = reset ? 0 : allHistory.value.length
      const fetchSize = currentCount + HISTORY_PAGE_SIZE
      const records = await window.electronAPI.history.getRecentAgentRecords(fetchSize, true) as AgentRecord[]
      const sorted = records.sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
      allHistory.value = sorted
      hasMoreHistory.value = records.length >= fetchSize
    } catch (e) {
      log.error('加载历史记录失败:', e)
    } finally {
      isLoadingAllHistory.value = false
    }
  }

  const loadMoreHistory = () => loadAllHistory(false)

  // 打开历史弹窗
  const openHistoryModal = async () => {
    showHistoryModal.value = true
    await loadAllHistory(true)
  }

  // 关闭历史弹窗
  const closeHistoryModal = () => {
    showHistoryModal.value = false
    allHistory.value = []
    hasMoreHistory.value = true
  }

  // 加载历史记录到当前会话
  const loadHistoryRecord = (record: AgentRecord) => {
    terminalStore.restoreAgentHistory(currentTabId.value, record)
    // 关闭弹窗（如果是从弹窗中选择的）
    closeHistoryModal()
  }

  // 检查是否有现有对话（用于确认是否覆盖）
  const hasExistingConversation = computed(() => {
    const steps = agentState.value?.steps || []
    return steps.length > 0
  })

  // 格式化历史时间
  const formatHistoryTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    
    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
  }

  // 远程 tab：从 IM 持久化配置加载执行模式
  const loadRemoteExecutionMode = async () => {
    if (!currentTab.value?.isRemote) return
    try {
      const config = await window.electronAPI.im.getConfig()
      if (config.executionMode && ['strict', 'relaxed', 'free'].includes(config.executionMode)) {
        executionMode.value = config.executionMode
      }
    } catch (err) {
      log.warn('Failed to load remote execution mode, using default:', err)
    }
  }

  // 生命周期
  onMounted(() => {
    setupAgentListeners()
    loadRecentHistory()
    loadRemoteExecutionMode()
  })

  onUnmounted(() => {
    cleanupAgentListeners()
    canvasStore.cleanup(currentTabId.value)
  })

  return {
    // 输入和终端状态
    inputText,
    isLoading,
    currentSystemInfo,
    terminalSelectedText,
    lastError,
    // 滚动相关
    hasNewMessage,
    isUserNearBottom,
    updateScrollPosition,
    scrollToBottom,
    scrollToBottomIfNeeded,
    stopGeneration,
    // Agent 执行
    executionMode,
    commandTimeout,
    activeProfileId,
    collapsedTaskIds,
    agentState,
    isAgentRunning,
    pendingConfirm,
    agentUserTask,
    currentPlan,
    agentTaskGroups,
    flattenedItems,
    isStreamingOutput,
    toggleStepsCollapse,
    isStepsCollapsed,
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
    hasMoreHistory,
    loadRecentHistory,
    loadAllHistory,
    loadMoreHistory,
    openHistoryModal,
    closeHistoryModal,
    loadHistoryRecord,
    hasExistingConversation,
    formatHistoryTime,
    saveCurrentSession,  // 保存当前会话（清空对话时调用）
    getAgentKey,  // 获取当前 tab 对应的 Agent 标识符
    // TTS 语音播报
    ttsIsSpeaking: tts.isSpeaking,
    ttsIsEnabled: tts.isEnabled,
    ttsToggle: tts.toggle,
    ttsStop: tts.stop,
  }
}
