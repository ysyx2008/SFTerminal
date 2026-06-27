/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 * 同时管理 AI 面板的滚动和终端状态
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { useAssistantArtifactStore } from '../workbench/assistant/artifact/store'
import type { ExecutionMode, AttachmentInfo, AgentRecord, AgentHistorySummary } from '@shared/types'
import type { AgentStep, AgentState } from '../stores/terminal'
import type { MessageScrollerHandle } from '../types/message-scroller'
import { readMessageScrollerCache } from '../types/message-scroller'
import { createLogger } from '../utils/logger'
import { isAssistantConversationSurfaceVisible } from '../utils/agent-tab-ui-meta'
import { useTts } from './useTts'
import { shouldShowToolResultStep } from '../utils/tool-display'
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

function readCacheSnapshot(scroller: MessageScrollerHandle | null | undefined) {
  return readMessageScrollerCache(scroller)
}

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
  type: 'user_task' | 'step' | 'final_result' | 'proactive_message' | 'confirm' | 'waiting_input'
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
  const artifactStore = useAssistantArtifactStore()
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
  let lastAutoScrollAt = 0
  let scrollGraceTimer: ReturnType<typeof setTimeout> | null = null
  const AUTO_SCROLL_GRACE_MS = 150

  // 启动 / 主动跳底窗口期内 ResizeObserver 仍贴底但**跳过 FLIP 动画**的时间戳。
  // scrollToBottom 触发时设置（new Date.now() + N ms）。语义：用户主动发新消息那一刻
  // 几个相邻的 wrapper 高度变化（user_task step / 初始占位 message step / 真实
  // message step 切换）彼此 FLIP 容易打架弹跳，且"主动跳底"本就是无动画语义，
  // 干脆这一段时间统一硬切贴底，之后才进入流式 FLIP。
  let suppressFlipUntil = 0

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

  const saveScrollTop = () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    const el = messagesRef.value
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    terminalStore.setAiScrollTop(id, el.scrollTop)
    if (maxScroll > 0) {
      terminalStore.setAiScrollRatio(id, el.scrollTop / maxScroll)
    }
    setIsUserNearBottom(checkIsNearBottom())

    const cache = readCacheSnapshot(scrollerRef?.value)
    if (cache?.keys.length) {
      terminalStore.setAiScrollCache(id, cache)
    }
  }

  const restoreScrollerCache = (): boolean => {
    const id = currentTabId.value
    const snapshot = id ? terminalStore.getAiScrollCache(id) : undefined
    if (!snapshot || !scrollerRef?.value?.restoreCache) return false
    return scrollerRef.value.restoreCache(snapshot)
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

  const restoreScrollTop = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    if (
      terminalStore.getAiScrollTop(id) === undefined
      && terminalStore.getAiScrollRatio(id) === undefined
    ) return

    scrollerRef?.value?.forceUpdate?.(false)

    const apply = () => {
      applySavedScrollTop()
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
      scrollerRef?.value?.forceUpdate?.(false)
    }, 150)
    // 虚拟列表 / Mermaid 等在 display:none 恢复后重测高度，晚到的 layout 需再对齐一次
    setTimeout(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    }, 500)
  }

  /** 切回激活 tab：先 restoreCache 再恢复滚动，减少 v3 重测高度闪烁 */
  const restoreScrollPositionOnTabActivate = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return

    restoreScrollerCache()
    scrollerRef?.value?.forceUpdate?.(false)
    await nextTick()

    if (terminalStore.getAiScrollNearBottom(id)) {
      scrollToHistoryBottomWithRetry()
    } else {
      await restoreScrollTop()
    }
  }

  /**
   * 历史恢复贴底期间隐藏消息列表，避免虚拟滚动尺寸重排造成的视觉弹跳。
   * opacity:0 不影响布局 / ResizeObserver 测量，待 scrollHeight 稳定后淡入。
   */
  const isHistoryScrollPending = ref(false)

  /**
   * 历史对话滚到底部（Virtual Scroller 重试 + 500ms 等待 mermaid/活图渲染后对齐）。
   * 默认启用同帧贴底（stickyFollowBottom + suppressFlipUntil），wrapper 重排时底部
   * 恒定，消除估算→实测高度修正造成的弹跳 / 切 tab 漂移。
   * @param opts.hideUntilSettled 历史"冷加载"路径传 true：额外 opacity:0，等 scrollHeight
   *        连续 2 rAF 稳定（或 520ms 兜底）后淡入，遮住新挂载场景 observer 未装上时的首次重排。
   *        pendingConfirm / 切 tab 等热路径不传，保持即时可见。
   */
  const scrollToHistoryBottomWithRetry = (opts?: { hideUntilSettled?: boolean }) => {
    const hide = opts?.hideUntilSettled === true
    if (hide) {
      isHistoryScrollPending.value = true
    }
    // 默认启用同帧贴底跟随：wrapper ResizeObserver 在 item 估算→实测高度重排时，
    // 于 layout 后 / paint 前把 scrollTop 钉到新底——等价于"以底部为锚点渲染"，
    // 底部恒定不动，高度修正全部发生在视区上方。
    // 切 tab 回到底部分支同样依赖此钉底：restoreScrollerCache 只能恢复此前测过的
    // item 尺寸，未测过的仍是 minItemSize 估算，scrollToBottom 会落在"估算底"；
    // 没有同帧钉底则 scrollTop 不跟随重排 → 停在距底几十 px，且 saveScrollTop 捕获
    // nearBottom=false / ratio<1.0，快速切换几次后稳态漂移到"上面一点"。
    // suppressFlipUntil 跳过 FLIP 动画：重排 delta 通常 ≥ MAX_FLIP_DELTA 本就硬切，
    // 小 delta（mermaid/活图、tab 切回的零星重测）也强制硬切，避免出现滑动。
    suppressFlipUntil = Date.now() + 600
    guardAfterAutoScroll()

    const apply = () => {
      if (scrollerRef?.value) {
        scrollerRef.value.scrollToBottom?.()
      } else {
        void scrollToBottom()
      }
    }
    void nextTick(() => {
      apply()
      setTimeout(() => {
        apply()
        saveScrollTop()
      }, 150)
      setTimeout(() => {
        apply()
        scrollerRef?.value?.forceUpdate?.(false)
        saveScrollTop()
      }, 500)

      if (!hide) return

      // 提前 reveal：scrollHeight 连续 2 rAF 不变即视为尺寸稳定（底部 items 已实测、
      // mermaid/活图已渲染）。兜底 520ms 与最后一次重试对齐，防止异步渲染过慢时永久隐身。
      let revealed = false
      let lastH = -1
      let stable = 0
      const doReveal = () => {
        if (revealed) return
        revealed = true
        isHistoryScrollPending.value = false
      }
      setTimeout(doReveal, 520)
      const tick = () => {
        if (revealed) return
        const el = messagesRef.value
        const h = el ? el.scrollHeight : 0
        if (h > 0 && h === lastH) stable++
        else stable = 0
        lastH = h
        if (stable >= 2) {
          doReveal()
        } else {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
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

  // 仅跟底意图为真时 ResizeObserver 才贴底；不可单独依赖 skipScrollUpdate——
  // grace 窗口内用户拖滚动条上滚时 skipScrollUpdate 仍为 true，会误把阅读位拽回底部（回归 bug）。
  const shouldFollowResize = () => shouldFollowBottom()

  const cancelFlipAnimation = () => {
    if (pendingFlipFrame !== null) {
      cancelAnimationFrame(pendingFlipFrame)
      pendingFlipFrame = null
    }
    const wrapper = contentObservedTarget
    if (wrapper) {
      wrapper.style.transition = ''
      wrapper.style.transform = ''
    }
  }

  /** 用户主动上滚离开底部：清除跟底粘性、grace 窗口与 FLIP，避免流式 chunk 继续拽底或整列晃动 */
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

    const { scrollTop } = el

    // 不在底部且 scrollTop 减小 → 用户上滚阅读，须优先于 skipScrollUpdate 早退
    // （拖滚动条上滚不会触发 wheel，但会触发 scroll；grace 期内早退会漏判）
    if (scrollTop < lastKnownScrollTop - 10 && !checkIsNearBottom()) {
      userScrolledAway()
      lastKnownScrollTop = scrollTop
      saveScrollTop()
      return
    }

    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return

    const nearBottom = checkIsNearBottom()
    const outsideAutoScrollGrace = Date.now() - lastAutoScrollAt > AUTO_SCROLL_GRACE_MS
    const scrolledUpSignificantly =
      outsideAutoScrollGrace && scrollTop < lastKnownScrollTop - SCROLL_THRESHOLD

    if (nearBottom) {
      stickyFollowBottom = true
      hasNewMessage.value = false
    } else if (scrolledUpSignificantly) {
      userScrolledAway()
      lastKnownScrollTop = scrollTop
      saveScrollTop()
      return
    }

    lastKnownScrollTop = scrollTop
    setIsUserNearBottom(nearBottom || stickyFollowBottom)
    saveScrollTop()
  }

  // 强制滚动到底部（用户主动发送消息或点击时调用）
  // ⚠️ 同 doScrollIfNeeded：本函数**不**主动跑 applyFlipScroll，FLIP 由 ResizeObserver
  // 单点负责。曾经尝试过让主动入口也跑 FLIP，但和 ResizeObserver 触发的 FLIP 累加成
  // 双倍偏移（applyFlipScroll 内部从当前 transform 累加），导致流式输出每行 wrapper
  // 高度变化都抖一下。让主动入口只设 scrollTop，由 ResizeObserver 兜底处理 FLIP。
  //
  // 但启动 Agent 那一刻几个相邻的 wrapper 高度变化（user_task / 占位 / 真实 message）
  // 彼此 FLIP 会打架弹跳。用户主动发新消息本就是"立即跳到底"的无动画语义，所以这里
  // 设 suppressFlipUntil 短暂窗口让 ResizeObserver 跳过 FLIP，只贴底。窗口过后第一个
  // 真正的流式 chunk 进来才进入 FLIP 平滑滑动。
  const FLIP_SUPPRESS_WINDOW_MS = 200
  const scrollToBottom = async () => {
    suppressFlipUntil = Date.now() + FLIP_SUPPRESS_WINDOW_MS

    await nextTick()
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
      lastKnownScrollTop = messagesRef.value.scrollTop
    }

    guardAfterAutoScroll()
    requestAnimationFrame(() => saveScrollTop())
  }

  // 实际执行滚动
  // ⚠️ 本函数**完全不设** scrollTop，FLIP + 贴底全交给 ResizeObserver。
  //
  // 历史踩坑：
  // 1. 曾经在这里 `el.scrollTop = el.scrollHeight` 兜底贴底，看似无害，但在
  //    vue-virtual-scroller 同步完成 totalSize 更新的场景下，scrollTop 在这一刻
  //    就跳到了新底，scrollDelta 立即被消化为 0；后续 ResizeObserver 触发时算出
  //    `scrollDelta = newScrollTop - oldScrollTop = 0` → **跳过 FLIP**。结果：
  //    工具卡 / 新 step 上来看不到动画（"工具卡硬切贴底"的回归 bug）。
  // 2. 曾经尝试在这里同时跑 applyFlipScroll，但和 ResizeObserver 路径累加变双倍
  //    偏移，流式每行抖一下。
  //
  // 正解：本函数只设 skipScrollUpdate 让 ResizeObserver 知道"请跟随贴底+FLIP"，
  // wrapper.height 真正变化的瞬间由 ResizeObserver 一次性完成 scrollTop 跳变 +
  // FLIP 反向偏移 + 下一帧归零，整套流程在同一 paint 周期内完成。
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    await nextTick()

    // 依赖 stickyFollowBottom / isUserNearBottom（由用户滚动 + 跟底意图维护）
    // 不做实时 checkIsNearBottom()：DynamicScroller 的 scrollHeight 基于估算，
    // 虚拟化的 off-screen 项高度远小于实际值，会导致误判"在底部附近"
    if (shouldFollowBottom()) {
      if (messagesRef.value) {
        // ⚠️ skipScrollUpdate 同时被 ResizeObserver 当作"正在贴底，跟随尺寸变化"信号
        //（见 installContentResizeObserver）。所以只能在确实要贴底的分支里置位，
        // 否则用户向上滚走后，新内容引发的 ResizeObserver 回调会被误触发为强制贴底，
        // 把用户从阅读位拽回最底（曾经的回归 bug）。
        stickyFollowBottom = true
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        extendScrollGrace()
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

  // ==================== 流式跟随：内容高度变化时同帧贴底 + FLIP 平滑滑动 ====================
  //
  // ⚠️ UX 不变量：流式 chunk 到达时新内容必须在浏览器 paint 之前完成贴底滚动。
  //    详见 electron/services/agent/SPEC.md §"流式输出同帧贴底跟随"。改动前必读。
  //    严禁改成 setTimeout 轮询、严禁改成基于 step.content 长度的内容驱动判断——
  //    会重新引入"半行先冒出再上挪"的视觉抖动。
  //
  // 流式输出时新内容会先在视区底部"露出半截 / 半行"再被滚到位，根因是 DynamicScroller
  // 的总高度（vue-recycle-scroller__item-wrapper.height）由 ResizeObserver 异步上报：
  // Vue patch DOM → 浏览器下次 layout 时 item ResizeObserver 触发 → DynamicScroller
  // 重算 totalSize → wrapper height 才更新。doScrollIfNeeded 在 nextTick 后调
  // scrollTop = scrollHeight，此刻 scrollHeight 还是旧值，于是滚到的是"旧底"，紧接
  // 着浏览器 paint 出新内容、半行裸露在视区底外，下一帧/下一次 chunk 才补上去。
  //
  // 这里直接监听 wrapper 自身的尺寸变化：ResizeObserver 在 layout 之后、paint 之前
  // 触发，那一刻把 scrollTop 钉到最新的 scrollHeight，浏览器同帧合成出来的画面已经
  // 是贴底状态——用户视觉上感受不到任何半行过渡。
  //
  // ===== FLIP 平滑滑动（叠加在同帧贴底之上，纯视觉层）=====
  // 同帧贴底解决了"半行抖动"，但内容上移仍是瞬间跳变（缺乏过渡感，UX 偏生硬）。
  // 解决方案：贴底后立刻给 wrapper 加 translateY(delta) 反向偏移（compositor 层，
  // 不影响 layout/scrollHeight），paint 出来视觉上等于"上方内容还在原位"；下一帧
  // 把 transform 归 0 + iOS spring 曲线 transition，让"上移"变成 280ms 的曲线滑动。
  //
  // 关键性质：
  // - transform 是 compositor 层属性，不影响 scrollHeight/scrollTop 计算，与同帧贴底
  //   不变量正交。
  // - vue-virtual-scroller 给 item-view 设 transform 定位，但不动 item-wrapper 的
  //   transform，所以我们独占该层。
  // - 连续 chunk 时 delta 累加：从当前 translateY 开始（解析 wrapper.style.transform），
  //   再叠加新 delta，下一帧统一归 0。这样动画总会"追到"最新内容。
  // - 用户主动滚走（isUserNearBottom = false）时不再跟进，正在跑的 transition 让它
  //   自然归 0，不会卡在中间。
  //
  // 改动这块前：必须保留"先 scrollTop 贴底、再 transform 反向偏移、下一帧归 0"的
  // 三步顺序；任何一步缺失或顺序错乱都会引发抖动或位移残留。
  let contentResizeObserver: ResizeObserver | null = null
  let contentObservedTarget: HTMLElement | null = null
  let prevWrapperHeight = 0
  let pendingFlipFrame: number | null = null

  // FLIP 动画参数
  // - cubic-bezier(0.32, 0.72, 0, 1)：iOS spring，慢启动 + 快收尾，符合"内容惯性归位"的物理直觉
  // - 基础 320ms 适合 1-3 行正文滑动；大 delta（图片、长段落）按比例延长到上限 560ms，
  //   避免把 600px 滑动塞进 320ms 显得"嗖一下"；同时防止超过 560ms 让用户觉得"慢一拍"
  // - MAX_FLIP_DELTA 600：上限再放宽到 600px（一张大图 + 几行文字的合理上限）。超过此值
  //   视为虚拟化重排（item 估算高度大幅修正），跳过动画避免长距离闪现
  const FLIP_BASE_DURATION_MS = 320
  const FLIP_MAX_DURATION_MS = 560
  const FLIP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
  const MAX_FLIP_DELTA = 600

  // 按位移量计算 duration：< 100px 用基础 320ms；> 100px 每 100px 加 60ms，封顶 560ms
  const computeFlipDuration = (offset: number): number => {
    const abs = Math.abs(offset)
    if (abs <= 100) return FLIP_BASE_DURATION_MS
    return Math.min(FLIP_MAX_DURATION_MS, FLIP_BASE_DURATION_MS + (abs - 100) * 0.6)
  }

  // 读取 wrapper 当前实际渲染的 translateY 值，用于"上一次归零动画还没跑完、新 chunk
  // 又来"的场景下累加。必须用 getComputedStyle 而非读 element.style：transition 进行
  // 中 element.style.transform 字符串已是目标值（"translateY(0px)"），但屏幕上渲染
  // 的是中间插值；getComputedStyle 返回 matrix(...) 形式，包含真实的中间 ty，否则
  // 累加起点错误会导致连续 chunk 时画面瞬间跳变。
  const readTranslateY = (el: HTMLElement): number => {
    const computed = getComputedStyle(el).transform
    if (!computed || computed === 'none') return 0
    // matrix(a, b, c, d, tx, ty) → 6 个值，ty 在 [5]
    // matrix3d(a1..a16) → 16 个值，ty 在 [13]
    const m = computed.match(/matrix(?:3d)?\(([^)]+)\)/)
    if (!m) return 0
    const values = m[1].split(',').map(v => parseFloat(v.trim()))
    if (values.length === 6) return values[5]
    if (values.length === 16) return values[13]
    return 0
  }

  // FLIP 反向偏移 + 下一帧归零的核心动作，抽成 helper 供 ResizeObserver 和
  // scrollToBottom 复用。**调用方必须先完成 scrollTop 跟随**，再传入实际产生的
  // scrollDelta；本函数只负责给 wrapper 加 translateY(scrollDelta) → 下一帧归零。
  // 三步顺序见 SPEC.md "FLIP 平滑滑动" 章节，不可错乱。
  const applyFlipScroll = (offset: number) => {
    const wrapper = contentObservedTarget
    if (!wrapper || offset <= 0 || offset >= MAX_FLIP_DELTA) return

    const currentY = readTranslateY(wrapper)
    const targetY = currentY + offset
    wrapper.style.transition = 'none'
    wrapper.style.transform = `translateY(${targetY}px)`

    if (pendingFlipFrame !== null) cancelAnimationFrame(pendingFlipFrame)
    const duration = computeFlipDuration(targetY)
    pendingFlipFrame = requestAnimationFrame(() => {
      pendingFlipFrame = null
      // 强制 reflow，确保上面的 transition: none + transform 被浏览器吃下，
      // 否则下一行的 transition 设置会跟当前帧合并，导致"瞬间跳到 0"无动画
      void wrapper.offsetHeight
      wrapper.style.transition = `transform ${duration}ms ${FLIP_EASING}`
      wrapper.style.transform = 'translateY(0)'
    })
  }

  const installContentResizeObserver = () => {
    uninstallContentResizeObserver()
    if (!messagesRef.value) return
    const wrapper = messagesRef.value.querySelector(
      '.vue-recycle-scroller__item-wrapper'
    ) as HTMLElement | null
    if (!wrapper) return
    contentObservedTarget = wrapper
    prevWrapperHeight = wrapper.offsetHeight
    contentResizeObserver = new ResizeObserver((entries) => {
      // 非当前激活 tab 不跟随贴底，避免后台 tab 改写 scrollTop、切回时与已存位置不一致
      if (tabActive?.value === false) return
      const el = messagesRef.value
      if (!el) return
      const newHeight = entries[0]?.contentRect.height ?? wrapper.offsetHeight
      const wrapperDelta = newHeight - prevWrapperHeight
      prevWrapperHeight = newHeight

      // 是否需要跟随贴底：
      // - skipScrollUpdate（强制贴底窗口期）：doScrollIfNeeded / scrollToBottom 等
      //   主动入口设置，新增 step / 工具卡的尺寸上报都在这 80ms 窗口内到来，需要继续
      //   跟随纠正 totalSize 异步上报引起的"旧底"
      // - isUserNearBottom：用户视觉在底部，常规流式 chunk 跟随
      // 两种场景都该走 FLIP 平滑滑动；用户主动滚走后 isUserNearBottom 为 false，
      // 不再越权强行贴底，避免和"用户翻看历史"的意图打架
      if (!shouldFollowResize()) return

      // wrapperDelta ≤ 0（wrapper 收缩，如图片渲染过程中的 markdown reflow 调整、
      // ThinkingBlock 折叠等）：完全不动 scrollTop，让浏览器自然 clamp。曾经在
      // 这里也 set scrollTop = scrollHeight，看似无害，但 scrollHeight 已变小，
      // scrollTop 被 clamp 到更小值 → 视区向下"塌"几像素 → 图片渲染时来回正负的
      // wrapperDelta 序列让用户看到"上下弹跳"。
      if (wrapperDelta <= 0) return

      // suppressFlipUntil 窗口期内（scrollToBottom 触发后短暂 200ms）跳过 FLIP，
      // 仍贴底——启动 Agent 那一刻几个相邻 wrapper 高度变化（user_task / 占位 /
      // 真实 message step）彼此 FLIP 容易打架弹跳，且主动跳底本就无动画语义。
      // 窗口过后第一个真正的流式 chunk 才进入 FLIP 平滑滑动。
      // wrapperDelta ≥ MAX_FLIP_DELTA：视为虚拟化重排（item 估算高度突然修正等异常
      // 情况），跳过动画但仍贴底，避免长距离闪现
      if (Date.now() < suppressFlipUntil || wrapperDelta >= MAX_FLIP_DELTA) {
        el.scrollTop = el.scrollHeight
        lastKnownScrollTop = el.scrollTop
        guardAfterAutoScroll()
        return
      }

      // ① 同帧贴底：layout 后、paint 前完成 scrollTop = scrollHeight，无半行抖动
      //    用 scrollDelta 而非 wrapperDelta 作为 FLIP 的实际偏移量——这才是用户真正
      //    感受到的"上方内容上移"距离。两者在标准贴底场景下一致；在"还没产生滚动条
      //    （内容不满视区）"场景下 scrollDelta=0 → 无 FLIP（修复"刚启动凭空抖动"）
      const oldScrollTop = el.scrollTop
      el.scrollTop = el.scrollHeight
      const scrollDelta = el.scrollTop - oldScrollTop
      lastKnownScrollTop = el.scrollTop
      guardAfterAutoScroll()

      // ② FLIP 反向偏移：scrollDelta > 0 时给 wrapper 加反向 transform，下一帧归零
      applyFlipScroll(scrollDelta)
    })
    contentResizeObserver.observe(wrapper)
  }

  const uninstallContentResizeObserver = () => {
    if (contentResizeObserver && contentObservedTarget) {
      contentResizeObserver.unobserve(contentObservedTarget)
      // 清理可能残留的 transform，避免下次 mount 时位置错乱
      contentObservedTarget.style.transition = ''
      contentObservedTarget.style.transform = ''
    }
    if (pendingFlipFrame !== null) {
      cancelAnimationFrame(pendingFlipFrame)
      pendingFlipFrame = null
    }
    contentResizeObserver?.disconnect()
    contentResizeObserver = null
    contentObservedTarget = null
    prevWrapperHeight = 0
  }

  const onMessagesWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) {
      userScrolledAway()
    }
  }

  // messagesRef 由 AiPanel 在 watch(scrollerRef) 中赋值；这里跟随它生命周期挂载/卸载
  // wrapper 是 DynamicScroller mount 后内部渲染的子节点，等一帧确保挂载完成
  watch(messagesRef, (el, oldEl) => {
    if (oldEl === el) return
    oldEl?.removeEventListener('wheel', onMessagesWheel)
    uninstallContentResizeObserver()
    if (el) {
      lastKnownScrollTop = el.scrollTop
      el.addEventListener('wheel', onMessagesWheel, { passive: true })
      requestAnimationFrame(() => installContentResizeObserver())
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
          const isFirst = i === 0
          const size = step.type === 'message'
            ? Math.max(80, Math.ceil(step.content.length / 4))
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
    if (!agentState.value?.sessionId) {
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
    void scrollToBottom()

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
      // 后端未推送 user_task（IPC 失败等）时固化乐观步骤，避免 __optimistic_ 前缀残留
      terminalStore.commitOptimisticAgentSteps(tabId)
      terminalStore.finalizeAgentRunState(tabId)
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
        alwaysAllow
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
      terminalStore.addAgentStep(tabId, data.step)

      // 独立助手模式下，驱动 Canvas 预览面板
      if (isStandaloneAssistant.value) {
        const steps = agentState.value?.steps ?? []
        artifactStore.handleAgentStep(tabId, data.step, steps)
      }

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

      terminalStore.finalizeAgentRunState(currentTabId.value)
      // 通知 Canvas 任务完成
      if (isStandaloneAssistant.value) {
        artifactStore.handleAgentComplete(currentTabId.value)
      }
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

      terminalStore.finalizeAgentRunState(currentTabId.value)
      queuedProactiveReply.value = null
      terminalStore.addAgentStep(currentTabId.value, {
        id: `error_${Date.now()}`,
        type: 'error',
        content: data.error,
        timestamp: Date.now()
      })

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
      const display = configStore.resolveConversationTitle(s.id, s.userTask)
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

    // 等待 Vue 响应式更新完成（DynamicScroller 挂载 / 列表项更新）
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
  const restoreCompanionHistoryIfNeeded = async () => {
    if (currentTab.value?.agentId !== COMPANION_TAB_AGENT_ID) return
    if ((agentState.value?.steps?.length ?? 0) > 0) return
    try {
      // 取最近 N 条 companion 会话合并展示，避免重启后只看到最后一条
      const records = await window.electronAPI.history.getRecentByAgentKey(COMPANION_TAB_AGENT_ID, 10)
      // await 期间可能有 live step 流入，再次确认仍为空才恢复，避免覆盖
      if (!records?.length) return
      if ((agentState.value?.steps?.length ?? 0) > 0) return
      const merged = mergeCompanionRecords(records as AgentRecord[])
      if (!merged) return
      terminalStore.restoreAgentHistory(currentTabId.value, merged)
    } catch (err) {
      log.warn('[Companion] 恢复历史会话失败:', err)
    }
  }

  // 把多条 companion 会话记录合成一条「展示用」记录：steps 按时间升序拼接。
  // ⚠️ id 与 timestamp 必须成对取「最新一条」：restoreAgentHistory 会把它们写成
  // agentState.sessionId / sessionStartTime 传给后端，续聊时 checkpoint 据此存盘。
  // 若像旧版那样 id 取最新、timestamp 取最早，后端会把记录存成「id 最新、timestamp
  // 最早」的错配记录——这正是联络「裂成两条 session、两条 timestamp 撞成一样」的放大器。
  // userTask（标题）仍取最早一条，展示合并对话从头开始，不影响 session 身份。
  const mergeCompanionRecords = (records: AgentRecord[]): AgentRecord | null => {
    if (!records.length) return null
    const ordered = [...records].sort((a, b) => a.timestamp - b.timestamp)
    const earliest = ordered[0]
    const latest = ordered[ordered.length - 1]
    const seen = new Set<string>()
    const steps = ordered
      .flatMap(r => r.steps ?? [])
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
      .filter(s => (s.id && !seen.has(s.id) ? (seen.add(s.id), true) : !s.id))
    // userTask 作为侧栏标题：优先取最早一条非 proactive 的记录标题；
    // 若全都是 proactive（纯主动消息、用户还未主动发言），回退到 earliest.userTask
    const firstRealRecord = ordered.find(r => r.userTask !== '__proactive__')
    const displayUserTask = firstRealRecord?.userTask ?? earliest.userTask
    return {
      ...latest,
      id: latest.id,
      timestamp: latest.timestamp,
      userTask: displayUserTask,
      steps,
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
    uninstallContentResizeObserver()
    artifactStore.cleanup(currentTabId.value)
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
