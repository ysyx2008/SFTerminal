/**
 * 侧栏历史对话空闲预热：复用「建 tab + restore」路径，但不 focus（不等于模拟 click）。
 * deviceMemory < 4 不预热；堆占用过高停队列；串行 + idle，不挡启动。
 */
import { onUnmounted, ref, type Ref } from 'vue'
import type { AgentRecord } from '@shared/types'
import { useTerminalStore } from '../stores/terminal'
import { createLogger } from '../utils/logger'

const log = createLogger('ConversationWarmup')

/** 与 Hub LRU 对齐的预热条数上限 */
const WARM_CAP_HIGH = 5
const WARM_CAP_MID = 3
const HEAP_USAGE_STOP_RATIO = 0.7

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number }
type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
}

/** deviceMemory < 4 或不可用 → 0；4–8 → 3；更大 → 5 */
export function resolveWarmBudget(): number {
  const dm = (navigator as NavigatorWithDeviceMemory).deviceMemory
  if (dm == null || dm < 4) return 0
  if (dm <= 8) return WARM_CAP_MID
  return WARM_CAP_HIGH
}

function isHeapTight(): boolean {
  const mem = (performance as PerformanceWithMemory).memory
  if (!mem?.jsHeapSizeLimit) return false
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit > HEAP_USAGE_STOP_RATIO
}

function scheduleIdle(cb: () => void): () => void {
  const ric = (window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  })
  if (typeof ric.requestIdleCallback === 'function') {
    const id = ric.requestIdleCallback(cb, { timeout: 4000 })
    return () => ric.cancelIdleCallback?.(id)
  }
  const id = window.setTimeout(cb, 2000)
  return () => clearTimeout(id)
}

function yieldToIdle(): Promise<void> {
  return new Promise(resolve => {
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void) => number
    })
    if (typeof ric.requestIdleCallback === 'function') {
      ric.requestIdleCallback(() => resolve())
    } else {
      setTimeout(resolve, 32)
    }
  })
}

export function useConversationWarmup(getCandidateIds: () => string[]) {
  const terminalStore = useTerminalStore()
  /** sessionId → 进行中的预热 Promise（用户点开时可 await） */
  const inflight = new Map<string, Promise<string | null>>()
  const warmingIds: Ref<Set<string>> = ref(new Set())
  let cancelIdle: (() => void) | null = null
  let stopped = false
  let started = false

  const markWarming = (id: string, on: boolean) => {
    const next = new Set(warmingIds.value)
    if (on) next.add(id)
    else next.delete(id)
    warmingIds.value = next
  }

  async function warmSession(sessionId: string): Promise<string | null> {
    if (stopped) return null
    if (terminalStore.findTabByHistoryId(sessionId)) return null
    if (isHeapTight()) return null

    const existing = inflight.get(sessionId)
    if (existing) return existing

    const task = (async () => {
      markWarming(sessionId, true)
      try {
        const record = (await window.electronAPI.history.getAgentRecordById(sessionId)) as
          | AgentRecord
          | undefined
        if (!record || stopped) return null
        if (isHeapTight()) return null
        return terminalStore.warmHistoryConversation(record)
      } catch (e) {
        log.warn('warmSession failed', sessionId, e)
        return null
      } finally {
        markWarming(sessionId, false)
        inflight.delete(sessionId)
      }
    })()

    inflight.set(sessionId, task)
    return task
  }

  async function runQueue() {
    const budget = resolveWarmBudget()
    if (budget <= 0) {
      log.debug('skip warmup: deviceMemory budget=0')
      return
    }

    const ids = getCandidateIds().filter(id => !terminalStore.findTabByHistoryId(id)).slice(0, budget)
    for (const id of ids) {
      if (stopped) break
      if (isHeapTight()) {
        log.debug('stop warmup: heap tight')
        break
      }
      await warmSession(id)
      await yieldToIdle()
    }
  }

  function start() {
    if (started) return
    started = true
    cancelIdle = scheduleIdle(() => {
      void runQueue()
    })
  }

  function stop() {
    stopped = true
    cancelIdle?.()
    cancelIdle = null
  }

  /** 用户点开时：若该条正在预热则等它完成（再走 open，命中热 tab） */
  function waitIfWarming(sessionId: string): Promise<string | null> | null {
    return inflight.get(sessionId) ?? null
  }

  onUnmounted(stop)

  return {
    start,
    stop,
    warmingIds,
    waitIfWarming,
    warmSession,
  }
}
