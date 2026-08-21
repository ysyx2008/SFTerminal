/**
 * 模型失败后换下一个：纯函数，不发请求、不读配置。
 * 触发条件用厂商协议码 / HTTP 状态，不用错误文案关键词。
 */

export type FailoverTrigger =
  | 'retries_exhausted'
  | 'model_not_found'
  | 'overloaded'
  | 'insufficient_quota'

/** 厂商协议里表示「这款模型用不了、换一个可能有用」的稳定 code/type */
const FAILOVER_API_CODES: Record<string, FailoverTrigger> = {
  model_not_found: 'model_not_found',
  not_found_error: 'model_not_found',
  overloaded_error: 'overloaded',
  insufficient_quota: 'insufficient_quota',
  insufficient_user_quota: 'insufficient_quota',
  arrearserror: 'insufficient_quota',
}

export interface ClassifyFailoverParams {
  /** 该模型自己的自动重试已经用尽 */
  retriesExhausted?: boolean
  statusCode?: number
  apiErrorCode?: string
}

/**
 * 这次失败该不该换模型。鉴权失败、内容违规、对话超长返回 null。
 */
export function classifyFailoverTrigger(params: ClassifyFailoverParams): FailoverTrigger | null {
  const code = params.apiErrorCode?.toLowerCase()
  if (code && FAILOVER_API_CODES[code]) {
    return FAILOVER_API_CODES[code]
  }
  if (params.statusCode === 404) return 'model_not_found'
  if (params.statusCode === 402) return 'insufficient_quota'
  if (params.statusCode === 503 || params.statusCode === 529) return 'overloaded'
  if (params.retriesExhausted) return 'retries_exhausted'
  return null
}

export interface FailoverCandidate {
  id: string
  contextLength?: number
}

/**
 * 按列表顺序给出候选：从第一个开始，跳过当前这条和已试过的。
 * minContextLength：跳过窗口明显更小的（避免刚切过去就报对话太长）。
 */
export function listFailoverCandidates<T extends FailoverCandidate>(
  profiles: T[],
  currentId: string,
  triedIds: ReadonlySet<string> = new Set(),
  minContextLength?: number,
): T[] {
  if (profiles.length <= 1) return []
  return profiles.filter(p => {
    if (p.id === currentId || triedIds.has(p.id)) return false
    if (
      minContextLength
      && p.contextLength
      && p.contextLength < minContextLength
    ) {
      return false
    }
    return true
  })
}

export interface AiModelFailoverNotice {
  fromId: string
  fromName: string
  usedId: string
  usedName: string
}
