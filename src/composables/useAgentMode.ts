/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 * 同时管理 AI 面板的滚动和终端状态
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { resolveConversationDisplayTitle } from '../utils/conversation-title'
import type { ExecutionMode, AttachmentInfo, AgentRecord, AgentHistorySummary } from '@shared/types'
import type { AgentStep, AgentState } from '../stores/terminal'
import type { MessageScrollerHandle } from '../types/message-scroller'
import { createLogger } from '../utils/logger'
import { isAssistantConversationSurfaceVisible } from '../utils/agent-tab-ui-meta'
import { useTts } from './useTts'
import { shouldShowToolResultStep } from '../utils/tool-display'
import { estimateMessageStepVirtualSize } from '../utils/thinking-block'
import { resolveWorkbenchAgentPrompt, resolveWorkbenchKind } from '../workbench'

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
  /**
   * group 在 agentTaskGroups 数组中的 0-based 索引。
   * fork（"另开一聊"）时 untilTaskCount = index + 1，对齐后端按 user_task step 的切分。
   */
  index: number
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
  type: 'user_task' | 'step' | 'final_result' | 'proactive_message' | 'proactive_notice' | 'confirm' | 'waiting_input'
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
  },
  scrollerRef?: Ref<MessageScrollerHandle | null>,
  tabActive?: Ref<boolean | undefined>
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const configStore = useConfigStore()
  const tts = useTts()

  watch(
    () => [configStore.ttsSettings.enabled, configStore.ttsSettings.autoSpeak] as const,
    ([enabled, autoSpeak]) => {
      if (enabled && autoSpeak) {
        tts.enable()
      } else if (tts.isEnabled.value) {
        tts.stop()
        tts.isEnabled.value = false
      }
    },
    { immediate: true },
  )

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

  // 用户主动跟底：发消息 / 点「新消息」后保持贴底跟随，直到用户明确上滚。
  // 虚拟列表 scrollHeight 异步修正时，scroll 事件会短暂误判「不在底部」；
  // 仅靠 checkIsNearBottom 会让 isUserNearBottom 抖动，hasNewMessage 闪烁并中断 ResizeObserver 跟底。
  let stickyFollowBottom = false
  let lastKnownScrollTop = 0
  let lastKnownScrollHeight = 0
  let lastAutoScrollAt = 0
  let scrollGraceTimer: ReturnType<typeof setTimeout> | null = null
  const AUTO_SCROLL_GRACE_MS = 150

  // 容器宽度变化驱动的 reflow 保护期截止时间戳。任何改变 AiPanel 宽度的操作
  // （产出物面板展开/收起、侧边栏、拖拽分隔条、窗口 resize、分屏）都会让聊天内容
  // reflow：同样内容变窄→变高，scrollHeight 变大但 scrollTop 不动，checkIsNearBottom()
  // 误判"离底"→污染 isUserNearBottom / 清掉 stickyFollowBottom → 流式 chunk 再来时
  // 停在上面一点并亮起「新消息」。reflow 期间 updateScrollPosition 跳过状态更新避免误判。
  let containerReflowGuardUntil = 0
  const CONTAINER_REFLOW_GUARD_MS = 500

  // hideUntilSettled 期间用 rAF 探测 scrollHeight 稳定后淡入；记录帧 / 定时器 id，
  // 组件卸载或重新触发时取消，避免卸载后 messagesRef 变 null 导致 tick 空转到兜底定时器。
  let pendingRevealFrame: number | null = null
  let pendingRevealTimer: ReturnType<typeof setTimeout> | null = null
  const cancelPendingReveal = () => {
    if (pendingRevealFrame !== null) {
      cancelAnimationFrame(pendingRevealFrame)
      pendingRevealFrame = null
    }
    if (pendingRevealTimer !== null) {
      clearTimeout(pendingRevealTimer)
      pendingRevealTimer = null
    }
  }

  // virtua 内置 scroll position adjustment，不再需要 FLIP / suppressFlip 机制。
  // suppressLayoutResizeCompensation 保留为空操作以兼容调用点；
  // 思考块展开的视区锚定由 anchorElementViewportY 负责。

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
  let cleanupContextBarListener: (() => void) | null = null
  let cleanupConfirmListener: (() => void) | null = null
  let cleanupConfirmResolvedListener: (() => void) | null = null
  let cleanupSecureInputListener: (() => void) | null = null
  let cleanupCompleteListener: (() => void) | null = null
  let cleanupErrorListener: (() => void) | null = null

  // 获取当前 tab（基于固定的 tabId）
  const currentTab = computed(() => {
    return terminalStore.tabs.find(t => t.id === currentTabId.value)
  })

  /** 设置里「启用 TTS + 自动朗读」且非远程会话时，对话流才喂给 TTS */
  const shouldAutoSpeak = computed(() =>
    configStore.ttsSettings.enabled
    && configStore.ttsSettings.autoSpeak
    && !currentTab.value?.isRemote
  )

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

  /**
   * scrollTop 下降是否由布局收缩/虚拟列表重测引起（浏览器 clamp scrollTop），
   * 而非用户主动上滚。ThinkingBlock 折叠、图片 reflow、item 估算→实测修正时常见。
   */
  const isLayoutInducedScrollUp = (el: HTMLElement): boolean => {
    const scrollTopDrop = lastKnownScrollTop - el.scrollTop
    if (scrollTopDrop <= 10) return false

    const scrollHeightDrop = lastKnownScrollHeight - el.scrollHeight
    if (scrollHeightDrop > 5 && scrollTopDrop <= scrollHeightDrop + 15) {
      return true
    }

    // sticky 跟底 / 程序化贴底后，scrollHeight 仍在变化时的 scroll 抖动，不计为用户离开
    if (
      stickyFollowBottom
      && Date.now() - lastAutoScrollAt < AUTO_SCROLL_GRACE_MS * 4
      && Math.abs(el.scrollHeight - lastKnownScrollHeight) > 5
    ) {
      return true
    }

    return false
  }

  const saveScrollTop = () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    const el = messagesRef.value
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    terminalStore.setAiScrollTop(id, el.scrollTop)
    if (maxScroll > 0) {
      terminalStore.setAiScrollRatio(id, el.scrollTop / maxScroll)
    }
    setIsUserNearBottom(checkIsNearBottom() || stickyFollowBottom)

    // 锚定复原：记"视口顶部那条 item 的 id + 距视口顶的 offset"。
    // findItemIndex 是 O(log n) 二分，每次 scroll 调用代价可忽略。
    const scroller = scrollerRef?.value
    if (scroller?.findItemIndex && scroller?.getItemOffset) {
      const idx = scroller.findItemIndex(el.scrollTop)
      const itemTop = scroller.getItemOffset(idx)
      const item = flattenedItems.value[idx]
      if (item?.id != null) {
        terminalStore.setAiScrollAnchor(id, { id: item.id, offset: el.scrollTop - itemTop })
      }
    }
  }

  const applySavedScrollTop = () => {
    if (!messagesRef.value) return
    const id = currentTabId.value
    if (!id) return
    const el = messagesRef.value
    const savedRatio = terminalStore.getAiScrollRatio(id)
    const saved = terminalStore.getAiScrollTop(id)
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    if (savedRatio !== undefined && maxScroll > 0) {
      el.scrollTop = savedRatio * maxScroll
    } else if (saved !== undefined) {
      el.scrollTop = saved
    }
  }

  /**
   * 锚定复原：用保存时的"视口顶 item id + offset"把那条消息钉回原视口位置。
   * scrollToIndex 内部用当前尺寸表算 itemPosition 再 scrollTop = itemPosition + offset，
   * offset 与上方 item 尺寸无关 → 即使上方估算→实测高度修正也不漂移。
   * 返回 false 时调用方回退到 ratio 复原。
   */
  const applyAnchorScrollTop = (): boolean => {
    const id = currentTabId.value
    if (!id) return false
    const anchor = terminalStore.getAiScrollAnchor(id)
    const scroller = scrollerRef?.value
    if (!anchor || !scroller?.scrollToIndex) return false
    const idx = flattenedItems.value.findIndex(i => i.id === anchor.id)
    if (idx < 0) return false
    scroller.scrollToIndex(idx, { align: 'start', offset: anchor.offset })
    return true
  }

  const restoreScrollTop = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    const hasAnchor = !!terminalStore.getAiScrollAnchor(id)
    const hasRatio = terminalStore.getAiScrollTop(id) !== undefined
      || terminalStore.getAiScrollRatio(id) !== undefined
    if (!hasAnchor && !hasRatio) return

    // 优先锚定复原（精确钉回原视口 item）；锚点失效（item 被删 / 库方法缺失）时回退 ratio
    const apply = () => {
      if (!applyAnchorScrollTop()) {
        applySavedScrollTop()
      }
    }

    apply()
    await nextTick()
    apply()
    requestAnimationFrame(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    })
    setTimeout(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    }, 150)
    // 虚拟列表 / Mermaid 等在 display:none 恢复后重测高度，晚到的 layout 需再对齐一次
    setTimeout(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    }, 500)
  }

  /** 切回激活 tab：恢复滚动位置 */
  const restoreScrollPositionOnTabActivate = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return

    await nextTick()

    if (terminalStore.getAiScrollNearBottom(id)) {
      scrollToHistoryBottomWithRetry()
    } else {
      await restoreScrollTop()
    }
  }

  /**
   * 历史恢复贴底期间隐藏消息列表，避免虚拟滚动尺寸重排造成的视觉弹跳。
   * opacity:0 不影响布局，待 scrollHeight 稳定后淡入。
   */
  const isHistoryScrollPending = ref(false)
  /** 历史冷加载 / 淡入后短窗口：禁指数追底，只硬钉（不延长打开等待） */
  let suppressFollowAnimUntil = 0

  /**
   * 历史对话滚到底部（重试 + 500ms 等待 mermaid/活图渲染后对齐）。
   * virtua 内置 scroll position adjustment，只需多次钉底即可。
   * @param opts.hideUntilSettled 历史冷加载路径传 true：额外 opacity:0，等 scrollHeight
   *        连续 2 rAF 稳定（或 520ms 兜底）后淡入；期间禁跟底滑动动画。
   */
  const scrollToHistoryBottomWithRetry = (opts?: { hideUntilSettled?: boolean }) => {
    const hide = opts?.hideUntilSettled === true
    if (hide) {
      // 冷加载：隐藏 + 禁跟底滑动，只硬钉；打开速度不变，避免测高过程中指数追底露馅
      isHistoryScrollPending.value = true
      suppressFollowAnimUntil = Math.max(suppressFollowAnimUntil, Date.now() + 600)
      cancelFollowScrollAnimation()
    }
    guardAfterAutoScroll()

    const apply = () => {
      // 历史路径一律硬钉，不走 animateFollowBottom
      pinFollowBottom()
    }
    void nextTick(() => {
      apply()
      setTimeout(() => {
        apply()
        saveScrollTop()
      }, 150)
      setTimeout(() => {
        apply()
        saveScrollTop()
      }, 500)

      if (!hide) return

      cancelPendingReveal()
      let revealed = false
      let lastH = -1
      let stable = 0
      const doReveal = () => {
        if (revealed) return
        revealed = true
        pendingRevealFrame = null
        pendingRevealTimer = null
        // 淡入前再硬钉一次；淡入后短窗口继续禁滑动（晚到的 mermaid/图片测高）
        pinFollowBottom()
        suppressFollowAnimUntil = Math.max(suppressFollowAnimUntil, Date.now() + 400)
        isHistoryScrollPending.value = false
      }
      pendingRevealTimer = setTimeout(doReveal, 520)
      const tick = () => {
        pendingRevealFrame = null
        if (revealed) return
        const el = messagesRef.value
        if (!el) return
        const h = el.scrollHeight
        if (h > 0 && h === lastH) stable++
        else stable = 0
        lastH = h
        if (stable >= 2) {
          doReveal()
        } else {
          pendingRevealFrame = requestAnimationFrame(tick)
        }
      }
      pendingRevealFrame = requestAnimationFrame(tick)
    })
  }

  /** 延长程序化贴底保护窗口，避免 scroll 事件在虚拟列表高度修正前误判离底 */
  const extendScrollGrace = () => {
    skipScrollUpdate = true
    if (scrollGraceTimer) clearTimeout(scrollGraceTimer)
    scrollGraceTimer = setTimeout(() => {
      scrollGraceTimer = null
      skipScrollUpdate = false
    }, AUTO_SCROLL_GRACE_MS)
  }

  /** ResizeObserver / scrollToBottom 程序化贴底后，短暂屏蔽 scroll 事件对跟底状态的污染 */
  const guardAfterAutoScroll = () => {
    lastAutoScrollAt = Date.now()
    stickyFollowBottom = true
    setIsUserNearBottom(true)
    hasNewMessage.value = false
    extendScrollGrace()
  }

  const shouldFollowBottom = () => stickyFollowBottom || isUserNearBottom.value

  /** 兼容保留：virtua 下视区锚定由调用方用 anchorElementViewportY 完成 */
  const suppressLayoutResizeCompensation = (_ms: number) => {
    // no-op
  }

  /** 把 anchorEl 钉回切换前的视口纵坐标，保持用户点击的那一行画面稳定 */
  const anchorElementViewportY = (anchorEl: HTMLElement, targetViewportTop: number) => {
    const el = messagesRef.value
    if (!el) return
    const delta = anchorEl.getBoundingClientRect().top - targetViewportTop
    if (Math.abs(delta) < 0.5) return
    el.scrollTop += delta
    lastKnownScrollTop = el.scrollTop
    lastKnownScrollHeight = el.scrollHeight
  }

  /**
   * 若 el 底部超出滚动容器视口，向下滚刚好露出（含 padding）。
   * @returns 是否发生了滚动
   */
  const ensureElementVisibleInViewport = (el: HTMLElement, padding = 16): boolean => {
    const container = messagesRef.value
    if (!container) return false
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const visibleBottom = containerRect.bottom - padding
    const overflow = elRect.bottom - visibleBottom
    if (overflow <= 0.5) return false
    container.scrollTop += overflow
    lastKnownScrollTop = container.scrollTop
    lastKnownScrollHeight = container.scrollHeight
    return true
  }

  // 容器宽度变化驱动的 reflow 进行中：此期间 scroll 事件算出的 checkIsNearBottom() 不可信
  // （scrollHeight 因宽度变化而变，与用户滚动意图无关），updateScrollPosition 应跳过状态更新。
  const isInContainerReflow = () => Date.now() < containerReflowGuardUntil

  /** Agent run 结束收口：清运行态 */
  const finalizeAgentRunWithScrollSettle = (tabId: string) => {
    terminalStore.finalizeAgentRunState(tabId)
  }

  /** 用户主动上滚离开底部：清除跟底粘性与 grace 窗口，避免流式 chunk 继续拽底 */
  const userScrolledAway = () => {
    stickyFollowBottom = false
    setIsUserNearBottom(false)
    // 不在这里亮起「新消息」：用户上滚不代表有新内容，只有 doScrollIfNeeded 发现
    // 实际有新内容到来且用户不在底部时才显示提示。
    if (scrollGraceTimer) {
      clearTimeout(scrollGraceTimer)
      scrollGraceTimer = null
    }
    skipScrollUpdate = false
    cancelFlipAnimation()
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    const el = messagesRef.value
    if (!el) return

    const { scrollTop, scrollHeight } = el

    // 不在底部且 scrollTop 减小 → 用户上滚阅读，须优先于 skipScrollUpdate 早退
    // （拖滚动条上滚不会触发 wheel，但会触发 scroll；grace 期内早退会漏判）
    // 布局收缩/虚拟列表重测导致的 scrollTop clamp 不算用户上滚，避免误清 stickyFollowBottom。
    if (scrollTop < lastKnownScrollTop - 10 && !checkIsNearBottom()) {
      if (!isLayoutInducedScrollUp(el)) {
        userScrolledAway()
        lastKnownScrollTop = scrollTop
        lastKnownScrollHeight = scrollHeight
        saveScrollTop()
        return
      }
      lastKnownScrollTop = scrollTop
      lastKnownScrollHeight = scrollHeight
      return
    }

    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return

    // 容器宽度变化驱动的 reflow 进行中：scrollHeight 因内容 reflow 而变，与用户滚动意图无关。
    // 此期间 checkIsNearBottom() 不可信，跳过状态更新，避免误判"离底"清掉 stickyFollowBottom。
    // 但保留"用户主动滚到底部→恢复跟底"的通道：reflow 期间用户仍可能主动滚到底，此时应恢复
    // stickyFollowBottom，避免 reflow 结束后第一次流式 chunk 因 sticky=false 而不贴底。
    if (isInContainerReflow()) {
      if (checkIsNearBottom()) {
        stickyFollowBottom = true
        setIsUserNearBottom(true)
      }
      lastKnownScrollTop = scrollTop
      lastKnownScrollHeight = scrollHeight
      return
    }

    const nearBottom = checkIsNearBottom()
    const outsideAutoScrollGrace = Date.now() - lastAutoScrollAt > AUTO_SCROLL_GRACE_MS
    const scrolledUpSignificantly =
      outsideAutoScrollGrace && scrollTop < lastKnownScrollTop - SCROLL_THRESHOLD

    if (nearBottom) {
      stickyFollowBottom = true
      hasNewMessage.value = false
    } else if (scrolledUpSignificantly) {
      if (!isLayoutInducedScrollUp(el)) {
        userScrolledAway()
        lastKnownScrollTop = scrollTop
        lastKnownScrollHeight = scrollHeight
        saveScrollTop()
        return
      }
    }

    lastKnownScrollTop = scrollTop
    lastKnownScrollHeight = scrollHeight
    setIsUserNearBottom(nearBottom || stickyFollowBottom)
    saveScrollTop()
  }

  // ==================== 跟底平滑滚动 ====================
  // 不用 translateY FLIP，也不用「from/to + 进度 p」的三次缓动：
  // 流式长高时重算 from/to 会放大瞬时速度，表现为流畅中突然微跳。
  // 改为每帧指数逼近当前底部：目标抬高只增加 remain，速度连续、无重定向尖峰。
  const FOLLOW_CATCHUP_RATE = 14 // ~250ms 收到 95%；略大则更跟手
  const FOLLOW_CATCHUP_BOOST_REMAIN = 280 // 落后较多时略加快，避免字快时拖尾
  let followAnimRaf: number | null = null
  let followAnimLastTs = 0

  const cancelFollowScrollAnimation = () => {
    if (followAnimRaf !== null) {
      cancelAnimationFrame(followAnimRaf)
      followAnimRaf = null
    }
    followAnimLastTs = 0
    const wrapper = followObservedTarget
    if (wrapper) {
      wrapper.style.transition = ''
      wrapper.style.transform = ''
    }
  }

  /** 兼容旧调用名 */
  const cancelFlipAnimation = cancelFollowScrollAnimation

  /** 硬切钉底（发消息 / 点新消息） */
  const pinFollowBottom = () => {
    cancelFollowScrollAnimation()
    const el = messagesRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    scrollerRef?.value?.scrollToBottom?.()
    lastKnownScrollTop = el.scrollTop
    lastKnownScrollHeight = el.scrollHeight
  }

  /** 跟底态：指数逼近底部；历史冷加载窗口内改硬钉，避免打开时露滑动 */
  const animateFollowBottom = () => {
    if (isHistoryScrollPending.value || Date.now() < suppressFollowAnimUntil) {
      pinFollowBottom()
      return
    }
    const el = messagesRef.value
    if (!el) return
    const target = Math.max(0, el.scrollHeight - el.clientHeight)
    if (target - el.scrollTop <= 0.5) return
    if (followAnimRaf !== null) return

    followAnimLastTs = 0
    const tick = (now: number) => {
      const box = messagesRef.value
      if (!box || !shouldFollowBottom()) {
        followAnimRaf = null
        followAnimLastTs = 0
        return
      }
      // 冷加载窗口中途切入：停动画、硬钉
      if (isHistoryScrollPending.value || Date.now() < suppressFollowAnimUntil) {
        followAnimRaf = null
        followAnimLastTs = 0
        pinFollowBottom()
        return
      }

      if (!followAnimLastTs) followAnimLastTs = now
      const dt = Math.min(0.048, (now - followAnimLastTs) / 1000)
      followAnimLastTs = now

      const latestTarget = Math.max(0, box.scrollHeight - box.clientHeight)
      const cur = box.scrollTop
      const remain = latestTarget - cur

      if (remain <= 0.5) {
        if (remain > 0) box.scrollTop = latestTarget
        lastKnownScrollTop = box.scrollTop
        lastKnownScrollHeight = box.scrollHeight
        followAnimRaf = null
        followAnimLastTs = 0
        return
      }

      // 1 - e^(-k dt)：逼近目标，不过冲；字快时 remain 大则自然加快
      const rate = remain > FOLLOW_CATCHUP_BOOST_REMAIN
        ? FOLLOW_CATCHUP_RATE * 1.35
        : FOLLOW_CATCHUP_RATE
      const alpha = 1 - Math.exp(-rate * dt)
      box.scrollTop = cur + remain * alpha
      lastKnownScrollTop = box.scrollTop
      lastKnownScrollHeight = box.scrollHeight
      followAnimRaf = requestAnimationFrame(tick)
    }

    followAnimRaf = requestAnimationFrame(tick)
  }

  const scrollToBottom = async () => {
    // 同步先设 sticky，避免 nextTick 前到达的 step 因 sticky=false 误判离底
    guardAfterAutoScroll()
    cancelFollowScrollAnimation()

    await nextTick()
    pinFollowBottom()

    guardAfterAutoScroll()
    requestAnimationFrame(() => saveScrollTop())
  }

  // 实际执行滚动：跟底意图交给 sticky；平滑追底由 followResizeObserver 单点完成。
  // 禁止在这里先硬钉底，否则 RO 看到 gap≈0，动画被跳过。
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    await nextTick()

    if (shouldFollowBottom()) {
      if (messagesRef.value) {
        stickyFollowBottom = true
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        extendScrollGrace()
        // RO 漏触发时的兜底：下一帧仍离底再追一次
        requestAnimationFrame(() => {
          const el = messagesRef.value
          if (!el || !shouldFollowBottom()) return
          if (!checkIsNearBottom()) {
            animateFollowBottom()
            guardAfterAutoScroll()
          }
        })
      }
    } else {
      hasNewMessage.value = true
    }
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

  // ==================== 跟底态：内容高度变化时平滑追底 ====================
  // virtua 负责上方 item 高度修正的视区锚定，但不负责「最后一项流式长高时保持贴底」。
  // 这里只在 shouldFollowBottom 且内容变高时启动/维持指数追底。
  let followResizeObserver: ResizeObserver | null = null
  let followObservedTarget: HTMLElement | null = null
  let prevFollowContentHeight = 0

  const installFollowResizeObserver = () => {
    uninstallFollowResizeObserver()
    const el = messagesRef.value
    if (!el) return
    // Virtualizer 是滚动容器的最后一个子节点（WelcomePanel / Modal 在其前或 fixed）
    const target = el.lastElementChild as HTMLElement | null
    if (!target) return
    followObservedTarget = target
    prevFollowContentHeight = target.offsetHeight
    followResizeObserver = new ResizeObserver((entries) => {
      if (tabActive?.value === false) return
      if (!shouldFollowBottom()) return
      const newH = entries[0]?.contentRect.height ?? target.offsetHeight
      const grew = newH > prevFollowContentHeight + 0.5
      prevFollowContentHeight = newH
      if (!grew) return

      guardAfterAutoScroll()
      animateFollowBottom()
    })
    followResizeObserver.observe(target)
  }

  const uninstallFollowResizeObserver = () => {
    cancelFollowScrollAnimation()
    if (followResizeObserver && followObservedTarget) {
      followResizeObserver.unobserve(followObservedTarget)
    }
    followResizeObserver?.disconnect()
    followResizeObserver = null
    followObservedTarget = null
    prevFollowContentHeight = 0
  }

  // ==================== 容器宽度变化感知（保留） ====================
  // virtua 处理动态高度的 scroll adjustment；这里只处理宽度变化导致的 reflow。
  let containerWidthObserver: ResizeObserver | null = null
  let prevContainerWidth = 0

  const installContainerWidthObserver = () => {
    uninstallContainerWidthObserver()
    const el = messagesRef.value
    if (!el) return
    prevContainerWidth = el.clientWidth
    containerWidthObserver = new ResizeObserver(() => {
      if (tabActive?.value === false) return
      const newWidth = el.clientWidth
      if (newWidth === prevContainerWidth) return
      prevContainerWidth = newWidth

      containerReflowGuardUntil = Date.now() + CONTAINER_REFLOW_GUARD_MS

      if (!shouldFollowBottom()) return

      guardAfterAutoScroll()
      void scrollToBottom()
    })
    containerWidthObserver.observe(el)
  }

  const uninstallContainerWidthObserver = () => {
    containerWidthObserver?.disconnect()
    containerWidthObserver = null
    prevContainerWidth = 0
    containerReflowGuardUntil = 0
  }

  const onMessagesWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) {
      userScrolledAway()
    }
  }

  // messagesRef 由 AiPanel 赋值；跟随它生命周期挂载/卸载观察器
  watch(messagesRef, (el, oldEl) => {
    if (oldEl === el) return
    oldEl?.removeEventListener('wheel', onMessagesWheel)
    uninstallFollowResizeObserver()
    uninstallContainerWidthObserver()
    if (el) {
      lastKnownScrollTop = el.scrollTop
      lastKnownScrollHeight = el.scrollHeight
      el.addEventListener('wheel', onMessagesWheel, { passive: true })
      requestAnimationFrame(() => {
        installFollowResizeObserver()
        installContainerWidthObserver()
      })
    }
  }, { flush: 'post' })

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

  const pendingSecureInput = computed(() => {
    return agentState.value?.pendingSecureInput
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

  // 获取当前 tab 对应的 Agent 标识符（agentKey）。
  //
  // 概念模型：一个 tab = 一个 Agent + N 个终端窗格。
  //   - 终端 tab：agentKey = tab.id（稳定，不随分屏/focus 变化）
  //   - 助手 tab：agentKey = tab.agentId（前端生成的 UUID）
  //
  // 后端 AgentService 用 agentKey 在 Map 中索引 Agent 实例。Agent 内部通过每次 run 的
  // context.ptyId 知道要操作哪个窗格——窗格切换不影响 Agent 实例。
  const getAgentKey = (): string | undefined => {
    const tab = currentTab.value
    if (!tab) return undefined
    if (tab.type === 'assistant') return tab.agentId
    return tab.id
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
    // user_task 尚未到达时先到的 user_supplement（准备阶段竞态）
    let leadingSupplements: AgentStep[] = []
    
    for (const step of allSteps) {
      if (step.type === 'user_task') {
        const isProactive = step.content === '__proactive__'
        const isOnboarding = step.content === '__onboarding__'
        currentGroup = {
          id: step.id,
          index: groups.length,
          userTask: (isProactive || isOnboarding) ? '' : step.content,
          images: step.images,
          attachments: step.attachments,
          steps: [...leadingSupplements],
          isCurrentTask: false,
          isProactive,
          isOnboarding,
        }
        leadingSupplements = []
        groups.push(currentGroup)
      } else if (step.type === 'final_result') {
        if (currentGroup) {
          currentGroup.finalResult = step.content
          currentGroup = null
        }
      } else if (step.type === 'user_supplement' && !currentGroup) {
        leadingSupplements.push(step)
      } else if (step.type === 'proactive_notice') {
        if (currentGroup) {
          currentGroup.steps.push(step)
        } else {
          // 无归属任务时作为独立主动通知（与历史 __proactive__ 分组等价）
          groups.push({
            id: step.id,
            index: groups.length,
            userTask: '',
            steps: [],
            isCurrentTask: false,
            isProactive: true,
            isOnboarding: false,
            finalResult: step.content,
          })
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

  /** 当前任务尚无 Agent 产出步骤时，在列表内注入虚拟「正在准备...」（非居中） */
  const shouldInjectPreparingStep = (group: AgentTaskGroup): boolean => {
    if (!group.isCurrentTask || group.finalResult || !isAgentRunning.value) return false
    return !group.steps.some(s =>
      s.type === 'thinking' || s.type === 'message' || s.type === 'tool_call' ||
      s.type === 'waiting' || s.type === 'asking' || s.type === 'waiting_password' ||
      s.type === 'error'
    )
  }

  const flattenedItems = computed((): VirtualItem[] => {
    const items: VirtualItem[] = []

    for (const group of agentTaskGroups.value) {
      if (group.isProactive) {
        // 历史格式（user_task __proactive__ + final_result）走 proactive_message 虚拟项
        if (group.finalResult) {
          items.push({ id: `proactive_${group.id}`, type: 'proactive_message', group, size: 80 })
        }
        continue
      }

      if (!group.isOnboarding) {
        items.push({ id: `user_${group.id}`, type: 'user_task', group, size: 60 })
      }

      if (group.steps.length > 0) {
        // 调试模式 OFF 时，隐藏"成功且无用户必看产出"的 tool_call / tool_result step
        const debugMode = configStore.agentDebugMode
        const visibleSteps = group.steps.filter(s => shouldShowToolResultStep(s, debugMode))
        for (let i = 0; i < visibleSteps.length; i++) {
          const step = visibleSteps[i]
          if (step.type === 'proactive_notice') {
            items.push({ id: step.id, type: 'proactive_notice', step, group, size: 80 })
            continue
          }
          const isFirst = i === 0
          const size = step.type === 'message'
            ? estimateMessageStepVirtualSize(step)
            : step.type === 'user_supplement' ? 60
            : step.type === 'asking' ? 120 : isFirst ? 46 : 40
          items.push({ id: step.id, type: 'step', step, group, size, isFirstStep: isFirst })
        }
      }

      // 后端 initial thinking step 到达前，在步骤流末尾补虚拟「正在准备...」（左侧 ThinkingBlock）
      if (shouldInjectPreparingStep(group)) {
        const userTaskStep = agentState.value?.steps.find(s => s.id === group.id)
        const preparingStep: AgentStep = {
          id: `__preparing_${group.id}`,
          type: 'thinking',
          content: t('ai.preparing'),
          isStreaming: true,
          timestamp: userTaskStep?.timestamp ?? Date.now(),
        }
        const hasPriorAgentStep = group.steps.some(s => s.type !== 'user_supplement')
        items.push({
          id: preparingStep.id,
          type: 'step',
          step: preparingStep,
          group,
          size: 46,
          isFirstStep: !hasPriorAgentStep,
        })
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

    if (pendingSecureInput.value) {
      items.push({ id: '__secure_input__', type: 'waiting_input', size: 220 })
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

    // 并发软上限检查：超过 MAX_CONCURRENT_AGENTS 时提示用户，但不强制阻止
    if (terminalStore.isAtConcurrencyLimit) {
      log.warn(`[concurrency] running=${terminalStore.runningAgentCount}, at limit, continuing anyway`)
      // toast 提示由调用方决定是否显示；这里仅记录日志，不阻塞手动操作
    }

    // 新任务开始，重置 TTS（会停止旧播报）
    if (shouldAutoSpeak.value) {
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

    // 同步收集附件/图片（不阻塞 UI）
    const images = imageCallbacks?.getImages() || []
    const previewImages = imageCallbacks?.getPreviewImages?.() || images
    if (images.length > 0) {
      imageCallbacks?.clearImages()
    }
    const attachments = attachmentCallbacks?.getAttachments() || []
    // getDocumentContext 依赖 uploadedDocs，须在其完成后再 clearAttachments

    // 立即进入运行态 + 乐观 user_task，用户消息与「正在准备...」零等待上墙
    terminalStore.clearAgentState(tabId, true)
    const isNewSession = !agentState.value?.sessionId
    if (isNewSession) {
      terminalStore.setAgentSession(tabId, `session_${startTime}`, startTime)
    }
    const stableAgentKey = isAssistantMode
      ? currentTab.value?.agentId
      : tabId
    terminalStore.setAgentRunning(tabId, true, stableAgentKey, message)
    terminalStore.addAgentStep(tabId, {
      id: `__optimistic_user_task_${startTime}`,
      type: 'user_task',
      content: message,
      images: previewImages.length > 0 ? previewImages : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: startTime,
    })
    guardAfterAutoScroll()
    void scrollToBottom()

    // 任务侧栏短标题：首条消息发出即异步生成，不阻塞 / 不等待 Agent
    // 联络常驻 tab 无侧栏标题；多轮续聊 / 已有自定义标题由后端跳过
    // 诞生引导：固定友好标题（LLM 会对 __…__ 跳过）
    if (
      isNewSession &&
      currentTab.value?.agentId !== COMPANION_TAB_AGENT_ID &&
      message.trim()
    ) {
      const sessionId = agentState.value?.sessionId
      if (sessionId) {
        if (message.trim() === '__onboarding__') {
          const friendlyTitle = t('ai.onboardingConversationTitle')
          terminalStore.setAgentSessionTitle(tabId, friendlyTitle)
          void window.electronAPI.history.setConversationTitle(sessionId, friendlyTitle)
            .catch(err => log.warn('setConversationTitle for onboarding failed:', err))
        } else {
          void window.electronAPI.history.generateConversationTitle(
            sessionId,
            message.trim(),
            activeProfileId.value || undefined
          ).then(title => {
            if (title) {
              terminalStore.setAgentSessionTitle(tabId, title)
            }
          }).catch(err => log.warn('generateConversationTitle failed:', err))
        }
      }
    }

    // 异步上下文在 UI 反馈之后并行获取，不阻塞首屏
    const [hostId, documentContext] = await Promise.all([
      getHostIdByTabId(tabId),
      getDocumentContext()
    ])

    if (attachments.length > 0) {
      attachmentCallbacks?.clearAttachments()
    }

    // 首次运行时自动探测主机信息（后台执行，不阻塞）
    autoProbeHostProfile().catch(e => {
      log.warn('主机探测失败:', e)
    })

    try {
      // 根据模式选择 API
      let result: { success: boolean; result?: string; error?: string; aborted?: boolean }

      // workbenchPrompt 对所有工作台类型都需要注入（local/ssh/assistant 各有专属 prompt；
      // companion 当前无）。先经 resolveWorkbenchKind 把 tab 映射成工作台类型再解析。
      const workbenchPrompt = currentTab.value
        ? resolveWorkbenchAgentPrompt(resolveWorkbenchKind(currentTab.value), currentTab.value)
        : undefined

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
            sessionStartTime: agentState.value?.sessionStartTime,
            ...(workbenchPrompt ? { workbenchPrompt } : {})
          },
          { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
          activeProfileId.value || undefined
        )
      } else {
        // agentKey = tabId（Agent 索引主键），context.ptyId = 当前激活窗格 ptyId（Agent 操作目标）。
        // 这两个不再耦合：Agent 实例归 tab 所有，跨多个窗格的生命周期。
        result = await window.electronAPI.agent.run(
          tabId,
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
            sessionStartTime: agentState.value?.sessionStartTime,
            ...(workbenchPrompt ? { workbenchPrompt } : {})
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
      const raw = error instanceof Error ? error.message : String(error || '')
      // IPC 序列化失败等不应把脏堆栈甩给用户（对齐 AiSettings testConnectionFailed）
      const isIpcNoise =
        raw.includes('Error invoking remote method') ||
        (raw.includes('SyntaxError') && raw.includes('is not valid JSON'))
      const errorMessage = isIpcNoise ? t('ai.agentIpcFailed') : (raw || t('ai.unknownError'))
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
      // 后端未推送 user_task（IPC 失败等）时固化乐观步骤，避免 __optimistic_ 前缀残留
      terminalStore.commitOptimisticAgentSteps(tabId)
      finalizeAgentRunWithScrollSettle(tabId)
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

  // alwaysAllow: 会话内存白名单（路径类等仍可用；命令类 UI 已改为加入规则）
  const confirmToolCall = async (
    approved: boolean,
    opts?: { alwaysAllow?: boolean },
  ) => {
    const confirm = pendingConfirm.value as (typeof pendingConfirm.value & { ptyId?: string }) | undefined
    if (!confirm) return

    // 必须用 needConfirm 事件里的 agentKey（ptyId），不能依赖当前激活 tab 的 getAgentKey()
    const agentKey = confirm.ptyId ?? confirm.agentId ?? getAgentKey()
    if (!agentKey) return

    try {
      await window.electronAPI.agent.confirm({
        ptyId: agentKey,
        toolCallId: confirm.toolCallId,
        approved,
        modifiedArgs: undefined,
        alwaysAllow: opts?.alwaysAllow,
      })
      const ownerTabId = terminalStore.findTabIdByPtyId(agentKey)
        ?? terminalStore.findTabIdByAgentId(agentKey)
        ?? currentTabId.value
      if (ownerTabId) {
        terminalStore.setAgentPendingConfirm(ownerTabId, undefined)
      }
    } catch (error) {
      log.error('确认工具调用失败:', error)
    }
  }

  /** 未知命令：二次确认后写入用户命令规则，再允许本次执行 */
  const confirmTrustCommandAndAllow = async () => {
    const confirm = pendingConfirm.value
    const offer = confirm?.trustCommandOffer
    if (!offer) return
    if (!window.confirm(t('ai.trustCommandConfirm', { cmd: offer.cmd }))) return
    try {
      const result = await window.electronAPI.commandRules.upsert({
        cmd: offer.cmd,
        baseLevel: offer.baseLevel,
        writesTo: offer.writesTo,
      })
      if (!result.ok) {
        window.alert(t('ai.trustCommandFailed'))
        return
      }
      await confirmToolCall(true)
    } catch (error) {
      log.error('信任命令并加入规则失败:', error)
      window.alert(t('ai.trustCommandFailed'))
    }
  }

  // 提交安全输入（用户在安全输入框里填了 key 并确认）
  const submitSecureInput = async (value: string) => {
    const req = pendingSecureInput.value
    if (!req) return
    const agentKey = getAgentKey()
    if (!agentKey) return
    try {
      await window.electronAPI.agent.resolveSecureInput({
        ptyId: req.ptyId || agentKey,
        requestId: req.requestId,
        value
      })
    } finally {
      if (currentTabId.value) {
        terminalStore.setAgentPendingSecureInput(currentTabId.value, undefined)
      }
    }
  }

  // 取消安全输入
  const cancelSecureInput = async () => {
    const req = pendingSecureInput.value
    if (!req) return
    const agentKey = getAgentKey()
    if (!agentKey) return
    try {
      await window.electronAPI.agent.resolveSecureInput({
        ptyId: req.ptyId || agentKey,
        requestId: req.requestId,
        cancelled: true
      })
    } finally {
      if (currentTabId.value) {
        terminalStore.setAgentPendingSecureInput(currentTabId.value, undefined)
      }
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
    // 将 agent 事件路由到 tab：终端 tab 用 ptyId（= tabId），助手 tab 用 tab.agentId
    const resolveTabIdForAgentEvent = (agentId: string, ptyId?: string): string | undefined => {
      if (ptyId) {
        return terminalStore.findTabIdByPtyId(ptyId)
          ?? terminalStore.findTabIdByAgentId(ptyId)
      }
      return terminalStore.findTabIdByAgentId(agentId)
    }

    const isEventForThisTab = (agentId: string, ptyId?: string): boolean => {
      const foundTabId = resolveTabIdForAgentEvent(agentId, ptyId)
      return foundTabId === currentTabId.value
    }
    
    // 监听步骤更新
    cleanupStepListener = window.electronAPI.agent.onStep((data: { agentId: string; ptyId?: string; step: AgentStep; wakeup?: boolean }) => {
      // 唤醒模式的 step 只给 Awaken 面板，不进入对话记录
      if (data.wakeup) return
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      
      const tabId = currentTabId.value
      // 后端 user_task 到达后替换乐观步骤（避免重复分组）
      if (data.step.type === 'user_task' && !data.step.id.startsWith('__optimistic_')) {
        terminalStore.removeOptimisticAgentSteps(tabId)
      }

      // 「准备中 → 思考中」切换：乐观移除 startup 占位，避免「占位 + 新 message」中间态闪现。
      // 后端 removeStep IPC 到达时 removeAgentStep 幂等跳过。
      if (data.step.type === 'message' && data.step.isStreaming) {
        const startupStep = (agentState.value?.steps ?? [])
          .find(s => s.placeholder === 'startup')
        if (startupStep) {
          terminalStore.removeAgentStep(tabId, startupStep.id)
        }
      }

      terminalStore.addAgentStep(tabId, data.step)

      // TTS: 流式 message / final_result 喂给语音合成（远程会话不播报）
      if (shouldAutoSpeak.value && tts.isEnabled.value) {
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

    cleanupContextBarListener = window.electronAPI.agent.onContextBar((data) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.setAgentContextBar(currentTabId.value, data.contextBar)
    })

    // 监听需要确认
    cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
      // 类型转换，添加 ptyId 支持
      const eventData = data as { agentId: string; ptyId?: string; toolCallId: string; toolName: string; toolArgs: Record<string, unknown>; riskLevel: string }
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(eventData.agentId, eventData.ptyId)) return
      
      terminalStore.setAgentPendingConfirm(currentTabId.value, data)

      // TTS 播报确认请求
      if (shouldAutoSpeak.value && tts.isEnabled.value) {
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
      // 多次滚动：虚拟列表测量实际高度需要时间，首次滚动可能基于估算值
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

    // 监听安全输入请求（技能 API Key 等）
    cleanupSecureInputListener = window.electronAPI.agent.onNeedSecureInput((data) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.setAgentPendingSecureInput(currentTabId.value, data)
      scrollToBottom()
      setTimeout(() => scrollToBottom(), 150)
    })

    // 监听完成
    cleanupCompleteListener = window.electronAPI.agent.onComplete((data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: string[] }) => {
      const foundTabId = data.ptyId
        ? terminalStore.findTabIdByPtyId(data.ptyId)
        : terminalStore.findTabIdByAgentId(data.agentId)
      // 只处理属于当前 AiPanel 绑定 tab 的事件（优先使用 ptyId 匹配）
      if (foundTabId !== currentTabId.value) return

      finalizeAgentRunWithScrollSettle(currentTabId.value)
      // 队列化的 proactive 回复优先：作为新任务启动（consumeProactiveContext 自动注入 Watch 上下文）
      if (queuedProactiveReply.value) {
        terminalStore.requestAgentCompleteTabAttentionSkip(foundTabId)
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
        terminalStore.requestAgentCompleteTabAttentionSkip(foundTabId)
        const pendingMessage = data.pendingUserMessages.join('\n')
        log.info('发现未处理的用户消息，将作为新任务启动:', pendingMessage)
        setTimeout(() => {
          inputText.value = pendingMessage
          runAgent()
        }, 100)
        return
      }

      // 任务在后台 tab 结束时，标签栏高亮（与待确认一致），便于多 tab 定位
      if (
        foundTabId &&
        !isAssistantConversationSurfaceVisible(
          foundTabId,
          terminalStore.activeTabId,
          terminalStore.hubFocusedAssistantTabId
        )
      ) {
        terminalStore.setAgentCompletedUnseen(foundTabId, true)
      }
    })

    // 监听错误
    cleanupErrorListener = window.electronAPI.agent.onError((data: { agentId: string; ptyId?: string; error: string }) => {
      const foundTabId = data.ptyId
        ? terminalStore.findTabIdByPtyId(data.ptyId)
        : terminalStore.findTabIdByAgentId(data.agentId)
      if (foundTabId !== currentTabId.value) return

      finalizeAgentRunWithScrollSettle(currentTabId.value)
      queuedProactiveReply.value = null
      // handleError 已通过 onStep 推送 error + final_result，此处不再重复 add error step。

      if (
        foundTabId &&
        !isAssistantConversationSurfaceVisible(
          foundTabId,
          terminalStore.activeTabId,
          terminalStore.hubFocusedAssistantTabId
        )
      ) {
        terminalStore.setAgentCompletedUnseen(foundTabId, true)
      }
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
    if (cleanupContextBarListener) {
      cleanupContextBarListener()
      cleanupContextBarListener = null
    }
    if (cleanupConfirmListener) {
      cleanupConfirmListener()
      cleanupConfirmListener = null
    }
    if (cleanupConfirmResolvedListener) {
      cleanupConfirmResolvedListener()
      cleanupConfirmResolvedListener = null
    }
    if (cleanupSecureInputListener) {
      cleanupSecureInputListener()
      cleanupSecureInputListener = null
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

  // 近期历史记录（用于欢迎页展示）
  const recentHistory = ref<AgentRecord[]>([])
  const isLoadingHistory = ref(false)

  // 查看更多弹窗：一次拉取索引中的全部标题摘要，本地筛选 + 分页展示；点开行再 getAgentRecordById
  const showHistoryModal = ref(false)
  const historyModalSummaries = ref<AgentHistorySummary[]>([])
  const isLoadingAllHistory = ref(false)
  const HISTORY_PAGE_SIZE = 20
  const historyModalDisplayCount = ref(HISTORY_PAGE_SIZE)
  const historySearchKeyword = ref('')

  /**
   * 输入框实时：仅本地按摘要标题（首条 user_task）筛选已加载的 listAgentSummaries。
   * 回车 / 搜索按钮：置 true 并走 IPC 全文检索（整段对话中的用户消息与结果等）。
   */
  const historyFullTextSearchActive = ref(false)
  const historySearchResults = ref<AgentRecord[]>([])
  const historySearchTotalMatched = ref(0)
  const historySearchHasMore = ref(false)
  const isHistorySearchLoading = ref(false)
  const historySearchFetchLimit = ref(HISTORY_PAGE_SIZE)
  const historySearchRequestId = ref(0)

  const clearHistorySearchState = () => {
    historySearchResults.value = []
    historySearchTotalMatched.value = 0
    historySearchHasMore.value = false
    historySearchFetchLimit.value = HISTORY_PAGE_SIZE
  }

  const executeHistorySearch = async (reqId: number) => {
    const kw = historySearchKeyword.value.trim()
    if (!kw) {
      if (reqId === historySearchRequestId.value) {
        isHistorySearchLoading.value = false
      }
      return
    }
    try {
      const res = await window.electronAPI.history.searchAgentRecords({
        keyword: kw,
        limit: historySearchFetchLimit.value,
        excludeWakeup: true,
      })
      if (reqId !== historySearchRequestId.value) return
      historySearchResults.value = res.records as AgentRecord[]
      historySearchTotalMatched.value = res.totalMatched
      historySearchHasMore.value = res.hasMore
    } catch (e) {
      log.error('搜索历史记录失败:', e)
      if (reqId !== historySearchRequestId.value) return
      historySearchResults.value = []
      historySearchTotalMatched.value = 0
      historySearchHasMore.value = false
    } finally {
      if (reqId === historySearchRequestId.value) {
        isHistorySearchLoading.value = false
      }
    }
  }

  const filteredHistorySummaries = computed(() => {
    const kw = historySearchKeyword.value.trim().toLowerCase()
    const base = historyModalSummaries.value
    if (!kw) return base
    return base.filter((s: AgentHistorySummary) => {
      const display = resolveConversationDisplayTitle(s)
      return [s.userTask, display].join(' ').toLowerCase().includes(kw)
    })
  })

  const allHistory = computed((): Array<AgentHistorySummary | AgentRecord> => {
    if (historyFullTextSearchActive.value) {
      return historySearchResults.value
    }
    return filteredHistorySummaries.value.slice(0, historyModalDisplayCount.value)
  })

  const hasMoreHistory = computed(() => {
    if (historyFullTextSearchActive.value) {
      return historySearchHasMore.value
    }
    return historyModalDisplayCount.value < filteredHistorySummaries.value.length
  })

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

  const loadMoreHistory = () => {
    if (historyFullTextSearchActive.value) {
      historySearchFetchLimit.value += HISTORY_PAGE_SIZE
      isHistorySearchLoading.value = true
      const reqId = historySearchRequestId.value
      void executeHistorySearch(reqId)
    } else {
      historyModalDisplayCount.value += HISTORY_PAGE_SIZE
    }
  }

  const setHistorySearchKeyword = (value: string) => {
    historySearchKeyword.value = value
    historyFullTextSearchActive.value = false
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
  }

  /** Enter / 搜索按钮：后端全文检索（非输入实时） */
  const flushHistorySearch = () => {
    const kw = historySearchKeyword.value.trim()
    if (!kw) {
      historyFullTextSearchActive.value = false
      historyModalDisplayCount.value = HISTORY_PAGE_SIZE
      clearHistorySearchState()
      return
    }
    historySearchRequestId.value += 1
    const reqId = historySearchRequestId.value
    historySearchFetchLimit.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = true
    // 立即清空旧结果，避免等待 IPC 时仍显示上一条全文结果，看起来像卡住
    historySearchResults.value = []
    historySearchTotalMatched.value = 0
    historySearchHasMore.value = false
    isHistorySearchLoading.value = true
    void executeHistorySearch(reqId)
  }

  const clearHistorySearch = () => {
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
  }

  // 打开历史弹窗：单次 IPC 读全量摘要（来自 agent-index.json）
  const openHistoryModal = async () => {
    showHistoryModal.value = true
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
    isLoadingAllHistory.value = true
    try {
      historyModalSummaries.value = await window.electronAPI.history.listAgentSummaries(true)
    } catch (e) {
      log.error('加载历史摘要失败:', e)
      historyModalSummaries.value = []
    } finally {
      isLoadingAllHistory.value = false
    }
  }

  // 关闭历史弹窗
  const closeHistoryModal = () => {
    showHistoryModal.value = false
    historyModalSummaries.value = []
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
  }

  // 加载历史记录到当前会话
  // 注意：仅把对话内容恢复到当前 tab 的 AiPanel，不改写 tab 标题。
  // 终端 tab 标题代表主机（本地/SSH），助手 tab 标题代表助手身份或用户手动重命名，
  // 加载历史对话不应覆盖既有标题；对话标题由侧栏/历史列表单独呈现。
  const loadHistoryRecord = async (record: AgentRecord) => {
    terminalStore.restoreAgentHistory(currentTabId.value, record)
    // 关闭弹窗（如果是从弹窗中选择的）
    closeHistoryModal()

    // 等待 Vue 响应式更新完成（Virtualizer 挂载 / 列表项更新）
    await nextTick()
    scrollToHistoryBottomWithRetry({ hideUntilSettled: true })
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

  // 联络常驻 tab：重启后会话为空时，载入上次 __companion__ 对话，避免一片空白。
  // 同一次运行内若已有 live steps（IM/Gateway 流入），则跳过，不覆盖现有对话。
  // 注意：这是「展示层」恢复（steps 上墙）。后端会话连续性由持久命名 Agent 自己的
  // restoreFromHistory/TaskMemory 负责——桌面续聊会新开 session 但带着恢复的工作记忆，
  // 因此前端这里无需关心 record.messages。
  // 合并视图由后端 Companion.getMergedViewRecord 产出（最近 N 条 companion record 的 steps
  // 按时间升序拼接，id/timestamp 成对取最新一条以对齐续聊上下文），前端不再自拼。
  const restoreCompanionHistoryIfNeeded = async () => {
    if (currentTab.value?.agentId !== COMPANION_TAB_AGENT_ID) return
    if ((agentState.value?.steps?.length ?? 0) > 0) return
    try {
      const merged = await window.electronAPI.history.getCompanionMergedView()
      // await 期间可能有 live step 流入，再次确认仍为空才恢复，避免覆盖
      if (!merged) return
      if ((agentState.value?.steps?.length ?? 0) > 0) return
      terminalStore.restoreAgentHistory(currentTabId.value, merged)
    } catch (err) {
      log.warn('[Companion] 恢复历史会话失败:', err)
    }
  }

  // 生命周期
  onMounted(() => {
    setupAgentListeners()
    loadRecentHistory()
    loadRemoteExecutionMode()
    void restoreCompanionHistoryIfNeeded()
  })

  onUnmounted(() => {
    cleanupAgentListeners()
    uninstallFollowResizeObserver()
    uninstallContainerWidthObserver()
    cancelPendingReveal()
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
    isHistoryScrollPending,
    updateScrollPosition,
    saveScrollTop,
    restoreScrollTop,
    restoreScrollPositionOnTabActivate,
    scrollToHistoryBottomWithRetry,
    scrollToBottom,
    scrollToBottomIfNeeded,
    suppressLayoutResizeCompensation,
    anchorElementViewportY,
    ensureElementVisibleInViewport,
    stopGeneration,
    // Agent 执行
    executionMode,
    commandTimeout,
    activeProfileId,
    collapsedTaskIds,
    agentState,
    isAgentRunning,
    pendingConfirm,
    pendingSecureInput,
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
    confirmTrustCommandAndAllow,
    submitSecureInput,
    cancelSecureInput,
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
    loadRecentHistory,
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
