/**
 * 上下文统计 composable
 * 估算 Token 使用量和上下文统计
 */
import { computed, ComputedRef } from 'vue'
import type { AiProfile } from '@shared/types'
import type { AgentStep } from '../stores/terminal'

// Agent 状态类型
interface AgentState {
  isRunning: boolean
  agentId?: string
  steps: AgentStep[]
  pendingConfirm?: unknown
  userTask?: string
  finalResult?: string
}

// 上下文统计结果
export interface ContextStatsResult {
  messageCount: number
  tokenEstimate: number
  maxTokens: number
  percentage: number
  /** 最近一次 API 调用的缓存命中率（0-100），undefined 表示无数据 */
  cacheHitRate?: number
  /** 本次实际使用的模型名称（视觉路由切换时与 activeAiProfile 不同） */
  effectiveModel?: string
}

export function useContextStats(
  agentState: ComputedRef<AgentState | undefined>,
  _agentUserTask: ComputedRef<string | undefined>,
  activeAiProfile: ComputedRef<AiProfile | null | undefined>
) {
  // 估算文本的 token 数量
  // 中文：约 1.5 字符/token，英文：约 4 字符/token
  const estimateTokens = (text: string): number => {
    if (!text) return 0
    
    // 统计中文字符数量
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    // 非中文字符数量
    const otherChars = text.length - chineseChars
    
    // 中文约 1.5 字符/token，英文约 4 字符/token
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  // 计算上下文使用情况
  // 优先使用后端返回的实际 token 数，比前端估算更准确
  const contextStats = computed((): ContextStatsResult => {
    let totalTokens = 0
    let messageCount = 0
    
    // Agent 模式：优先使用后端返回的 contextTokens
    const allSteps = agentState.value?.steps || []
    
    // 从最新的步骤中获取后端返回的 contextTokens、cacheHitRate、effectiveContextLength 和 effectiveModel
    let cacheHitRate: number | undefined
    let effectiveContextLength: number | undefined
    let effectiveModel: string | undefined
    for (let i = allSteps.length - 1; i >= 0; i--) {
      const step = allSteps[i]
      if (step.contextTokens !== undefined) {
        totalTokens = step.contextTokens!
        cacheHitRate = step.cacheHitRate
        // 优先使用后端写入的实际模型信息（视觉路由切换时与 activeAiProfile 不同）
        effectiveContextLength = step.effectiveContextLength
        effectiveModel = step.effectiveModel
        break
      }
    }
    
    messageCount = allSteps.length
    
    // effectiveContextLength 优先：当发生视觉模型自动切换时，此值反映切换后模型的限制
    const maxTokens = effectiveContextLength || activeAiProfile.value?.contextLength || 128000
    // effectiveModel 优先，回退到当前配置的 profile 名称
    const modelName = effectiveModel || activeAiProfile.value?.name
    
    return {
      messageCount,
      tokenEstimate: totalTokens,
      maxTokens,
      percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 100)),
      cacheHitRate,
      effectiveModel: modelName
    }
  })

  return {
    estimateTokens,
    contextStats
  }
}
