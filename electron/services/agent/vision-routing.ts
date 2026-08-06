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
 * 有毒的只有一种组合：主模型构建的**无图长前缀** + 本轮**新图首投**视觉模型——
 * 豆包等对从未见过的 DeepSeek 前缀多模态请求报 `UnsupportedImageFormat`，
 * 触发剥图降级，Agent 只能答「画面没传过来」。冷启动只保留压缩后的短上下文+新图。
 *
 * 前缀已有图则**不**跳过：图只能经视觉可用路径进入消息，前缀带图说明视觉模型
 * 已接受过这段前缀，复用安全；此时跳过反而迫使冷启动，而冷启动的 L1/L2 压缩
 * 按文本重建会剥掉历史图（2026-08-06 续聊丢图回归）。
 */
export function shouldSkipCachePathForVision(
  params: ResolveBudgetProfileParams & {
    usingCachePath: boolean
    /** 本轮是否新增图片（context.images / 待 flush 补充消息），不含前缀/历史里已有的图 */
    hasNewImagesThisTurn: boolean
    /** cache 前缀是否已含图片（含图 = 视觉模型已接受过该前缀，复用安全） */
    prefixHasImages: boolean
  },
): boolean {
  if (!params.usingCachePath) return false
  // 仅「新图首投无图前缀」才需要避开主模型前缀；其余场景（无新图 / 前缀已带图）
  // 复用不会引入视觉模型没见过的内容（见 claude-review 3.2 的契约自文档化考量）。
  if (!params.hasNewImagesThisTurn || params.prefixHasImages) return false
  const effective = resolveBudgetProfileId(params)
  const main = params.mainProfileId || params.activeProfileId
  return !!effective && !!main && effective !== main
}
