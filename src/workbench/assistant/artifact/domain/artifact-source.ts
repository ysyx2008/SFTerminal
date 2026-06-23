/**
 * 产出物来源溯源：canvasData 常挂在已隐藏的 tool_result 上，
 * 跳转时应落到 UI 可见的 tool_call。
 */
import type { CanvasData } from '@shared/types'

export type SourceStepLike = {
  id: string
  type: string
  toolCallId?: string
  toolName?: string
}

/** 将 step（多为 tool_result）解析为对话流中可见的 sourceStepId */
export function resolveVisibleSourceStepId(
  sourceStep: SourceStepLike,
  allSteps: readonly SourceStepLike[]
): string {
  if (sourceStep.type === 'tool_call') return sourceStep.id

  if (sourceStep.toolCallId) {
    const paired = allSteps.find(
      s => s.type === 'tool_call' && s.toolCallId === sourceStep.toolCallId
    )
    if (paired) return paired.id
  }

  if (sourceStep.type === 'tool_result' && sourceStep.toolName) {
    const idx = allSteps.findIndex(s => s.id === sourceStep.id)
    const searchEnd = idx >= 0 ? idx : allSteps.length
    for (let i = searchEnd - 1; i >= 0; i--) {
      const candidate = allSteps[i]
      if (candidate.type !== 'tool_call' || candidate.toolName !== sourceStep.toolName) {
        continue
      }
      if (
        sourceStep.toolCallId &&
        candidate.toolCallId &&
        candidate.toolCallId !== sourceStep.toolCallId
      ) {
        continue
      }
      return candidate.id
    }
  }

  return sourceStep.id
}

/** 按 stepId 查找并解析（兼容已存入 tool_result id 的旧 artifact） */
export function resolveSourceStepIdById(
  stepId: string,
  allSteps: readonly SourceStepLike[]
): string {
  const step = allSteps.find(s => s.id === stepId)
  if (!step) return stepId
  return resolveVisibleSourceStepId(step, allSteps)
}

export function enrichCanvasDataFromStep(
  data: CanvasData,
  step: SourceStepLike,
  allSteps: readonly SourceStepLike[] = []
): CanvasData {
  if (data.action !== 'open' || data.sourceStepId) return data
  return { ...data, sourceStepId: resolveVisibleSourceStepId(step, allSteps) }
}
