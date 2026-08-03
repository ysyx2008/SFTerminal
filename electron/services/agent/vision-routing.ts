/**
 * 视觉模型路由 —— 纯函数
 *
 * 主模型（general）遇到会话内图片时，可自动切到关联的 visionProfileId。
 * 上下文预算 / cache path / UI 展示必须与真实 API 调用用同一份 profile，
 * 否则会出现「按 DeepSeek 1000K 复用上下文 → 实际打到豆包 256K 超限」的错位。
 */
import type { AiProfile } from '@shared/types'

export interface ResolveBudgetProfileParams {
  /** Agent 当前绑定的主模型 profileId（可为 undefined，走 active） */
  mainProfileId: string | undefined
  /** 全局 active profile（main 缺省时的回退） */
  activeProfileId: string
  profiles: AiProfile[]
  /** 全局「遇到图片自动切视觉模型」开关 */
  autoVisionModel: boolean
  /** 本次请求消息体是否会携带多模态图片 */
  hasImages: boolean
}

/**
 * 解析「上下文预算与 API 调用」应使用的 profileId。
 * 有图且配置了有效 visionProfileId → 返回视觉模型；否则返回主模型。
 */
export function resolveBudgetProfileId(params: ResolveBudgetProfileParams): string | undefined {
  const { mainProfileId, activeProfileId, profiles, autoVisionModel, hasImages } = params
  if (!autoVisionModel || !hasImages) return mainProfileId

  const currentId = mainProfileId || activeProfileId
  const current = profiles.find(p => p.id === currentId)
  if (!current) return mainProfileId
  if (current.modelType === 'vision') return mainProfileId

  const visionId = current.visionProfileId
  if (visionId && visionId !== currentId && profiles.some(p => p.id === visionId)) {
    return visionId
  }
  return mainProfileId
}

/**
 * 是否应跳过 `_previousRunMessages` 的 cache path，改走冷启动重建。
 *
 * 跨模型切到关联视觉模型（如 DeepSeek → 豆包）且本轮带图时，不能把主模型的
 * 长前缀原样塞给视觉模型多模态请求——豆包等会因 `UnsupportedImageFormat` 报错，
 * 触发剥图降级，Agent 只能答「画面没传过来」。冷启动只保留压缩后的短上下文+新图。
 *
 * 仅跨模型路由到 vision（与主模型不同）且带图时返回 true；同 profile / 主模型
 * 本身 vision / 无图时保持原 cache 行为。
 */
export function shouldSkipCachePathForVision(
  params: ResolveBudgetProfileParams & { usingCachePath: boolean },
): boolean {
  if (!params.usingCachePath) return false
  // 契约自文档化：仅带图时考虑跳过；未来 resolveBudgetProfileId 新增其它路由到
  // vision 的理由时，不会把无图请求也误判为跳过（见 claude-review 3.2）。
  if (!params.hasImages) return false
  const effective = resolveBudgetProfileId(params)
  const main = params.mainProfileId || params.activeProfileId
  return !!effective && !!main && effective !== main
}
