/**
 * Agent 步骤导航（平台壳 ↔ 岗侧面板），与产出物 store 解耦。
 *
 * ArtifactPanel 等调用 requestScrollToAgentStep；
 * AiPanel 通过 useScrollToAgentStepRequest 消费（兄弟槽位无法 provide/inject）。
 */
import { ref, watch, type Ref } from 'vue'

export interface AgentStepScrollRequest {
  tabId: string
  stepId: string
}

const pendingRequest: Ref<AgentStepScrollRequest | null> = ref(null)

export function requestScrollToAgentStep(tabId: string, stepId: string): void {
  pendingRequest.value = { tabId, stepId }
}

export function clearScrollToAgentStepRequest(): void {
  pendingRequest.value = null
}

/** AiPanel 挂载：监听本 tab 的跳转请求并滚到对应 step */
export function useScrollToAgentStepRequest(
  tabId: Ref<string> | (() => string),
  scrollToStep: (stepId: string) => void | Promise<void>,
): void {
  watch(
    pendingRequest,
    (req) => {
      const id = typeof tabId === 'function' ? tabId() : tabId.value
      if (!req || req.tabId !== id) return
      void scrollToStep(req.stepId)
      clearScrollToAgentStepRequest()
    },
    { immediate: true },
  )
}
