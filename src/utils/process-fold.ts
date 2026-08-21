/**
 * 过程折叠：一个任务在界面上只有两种东西——它说给你听的话留在外面，它做事的过程收成一行。
 *
 * 那一行从任务开始到结束位置不动、行数不变，只换内容（跑着时说它在忙什么，做完说做了什么），
 * 所以不存在"冒出来又消失"。不为折叠另写摘要：动作从工具调用数出来，忙什么用它自己写下的思考。
 */
import { parseThinking } from './thinking-block'
import { ALWAYS_SHOW_RESULT_TOOLS, hasRichPayload } from './tool-display'

export type ActionKind = 'read' | 'write' | 'edit' | 'command' | 'search' | 'browse' | 'other'

export const ACTION_KIND_ORDER: ActionKind[] = [
  'read', 'write', 'edit', 'command', 'search', 'browse', 'other',
]

/** 已知工具 → 动作桶。未登记的进 other。封闭表，不是内容模式匹配。 */
export const TOOL_ACTION_KIND: Record<string, ActionKind> = {
  read_file: 'read',
  read_remote_file: 'read',
  read_remote_text_file: 'read',
  get_knowledge_doc: 'read',
  sftp_get: 'read',
  write_text_file: 'write',
  write_remote_text_file: 'write',
  sftp_put: 'write',
  word_from_markdown: 'write',
  excel_from_markdown: 'write',
  edit_file: 'edit',
  execute_command: 'command',
  exec: 'command',
  await_exec: 'command',
  file_search: 'search',
  search_knowledge: 'search',
  web_search: 'search',
  search_history: 'search',
  recall: 'search',
  web_fetch: 'browse',
  browser_launch: 'browse',
  browser_goto: 'browse',
  browser_snapshot: 'browse',
  browser_read_article: 'browse',
  browser_read_page: 'browse',
  browser_get_content: 'browse',
}

/**
 * 留在外面的步骤类型。只有两类够格：**要你动手的**（问你问题、等你输密码、等你确认）
 * 和**它交给你的东西**（任务级错误、计划、你自己补的话）。
 * 注意任务级 `error` 在外面，但过程中某次工具失败不在——它试三次成了就是成了。
 */
const PINNED_STEP_TYPES = new Set([
  'asking',
  'waiting',
  'waiting_password',
  'waiting_input',
  'error',
  'user_supplement',
  'proactive_notice',
  'plan_created',
  'plan_updated',
  'plan_archived',
])

/** 对外发出去的：主动联系、往对话里寄东西——是产出不是过程 */
const PINNED_TOOLS = new Set<string>([
  ...ALWAYS_SHOW_RESULT_TOOLS,
  'send_to_chat',
])

const PROGRESS_MAX_CHARS = 60
/** 做完之后耗时不到 1 秒就不提，省得挂个「· 0s」 */
const MIN_SHOWN_DURATION_MS = 1000

export interface ProcessStepLike {
  id: string
  type: string
  content?: string
  toolName?: string
  success?: boolean
  riskLevel?: string
  isStreaming?: boolean
  timestamp?: number
  images?: unknown[]
  echartsOption?: unknown
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}

export interface ProcessFoldView {
  id: string
  counts: Partial<Record<ActionKind, number>>
  /** 这一截还在跑：那一行要转圈、秒数要走 */
  live: boolean
  /** 跑着的时候它在忙什么——它自己写下的那句思考 */
  liveText?: string
  /** 没有思考可用时退回动作分类 */
  liveAction?: ActionKind
  /** 计时锚点：从上一步结束算起 */
  startedAt?: number
  /** 做完了共花多久；太短则不给 */
  durationMs?: number
  stepIds: string[]
}

export type ProcessSegment =
  | { kind: 'open'; steps: ProcessStepLike[] }
  | { kind: 'fold'; fold: ProcessFoldView; steps: ProcessStepLike[] }

/**
 * 流式期间每来一段内容整条步骤流都要重判一遍，历史长了正则解析全部消息不划算。
 * 按步骤对象缓存，原文变了就重算，步骤被回收缓存自动消失。
 */
const parsedCache = new WeakMap<ProcessStepLike, { content: string; parsed: ReturnType<typeof parseThinking> }>()

function parsed(step: ProcessStepLike) {
  const content = step.content || ''
  const hit = parsedCache.get(step)
  if (hit && hit.content === content) return hit.parsed
  const result = parseThinking(content)
  parsedCache.set(step, { content, parsed: result })
  return result
}

function messageBody(step: ProcessStepLike): string {
  if (step.type !== 'message') return ''
  return parsed(step).body.trim()
}

/** 这一步是它说给用户听的话（而不是光在想）——这类步骤永远留在外面 */
export function hasSpokenBody(step: ProcessStepLike): boolean {
  return !!messageBody(step)
}

/**
 * 留在原处不收的步骤。除了要你动手的、任务级错误、对外发出的、带产出的，
 * **它说给你听的话也一律留在原处**——折叠行因此永远落在这段过程原来的位置，
 * 展开与否，读到的顺序都和它当时干活的顺序一样。
 *
 * 刻意不在此列的：过程中某次工具失败、正在跑的工具、还在流的思考——
 * 这些全是过程，收进那一行里，跑着的时候由那一行代为播报。
 */
export function isPinnedProcessStep(step: ProcessStepLike): boolean {
  if (PINNED_STEP_TYPES.has(step.type)) return true
  if (step.riskLevel === 'dangerous' || step.riskLevel === 'blocked') return true
  if (step.toolName && PINNED_TOOLS.has(step.toolName)) return true
  if (hasRichPayload(step)) return true
  if (messageBody(step)) return true
  return false
}

/** 这一步还没完：工具没回，或内容还在流 */
function isUnfinished(step: ProcessStepLike): boolean {
  if (step.isStreaming) return true
  return step.type === 'tool_call' && step.success === undefined
}

export function countActions(steps: ReadonlyArray<ProcessStepLike>): Partial<Record<ActionKind, number>> {
  const counts: Partial<Record<ActionKind, number>> = {}
  for (const step of steps) {
    if (step.type !== 'tool_call') continue
    const kind = (step.toolName && TOOL_ACTION_KIND[step.toolName]) || 'other'
    counts[kind] = (counts[kind] || 0) + 1
  }
  return counts
}

export function lastProgressLine(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const raw = lines[lines.length - 1] || ''
  const cleaned = raw.replace(/^(?:[-*•]|\d+\.)\s+/, '').replace(/^#{1,6}\s+/, '')
  if (cleaned.length <= PROGRESS_MAX_CHARS) return cleaned
  return `${cleaned.slice(0, PROGRESS_MAX_CHARS - 1)}…`
}

/** 它此刻在忙什么：拿最近一次思考的尾句。跑着的时候思考还没写完也算数。 */
export function extractProgressLine(steps: ReadonlyArray<ProcessStepLike>): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    let reasoning = ''
    if (step.type === 'message') {
      reasoning = parsed(step).thinking?.reasoning || ''
    } else if (step.type === 'thinking') {
      reasoning = step.content || ''
    }
    if (!reasoning.trim()) continue
    const line = lastProgressLine(reasoning)
    if (line) return line
  }
  return undefined
}

/** 跑着的时候手上这件事属于哪一类动作 */
function pendingAction(steps: ReadonlyArray<ProcessStepLike>): ActionKind | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'tool_call') continue
    return (step.toolName && TOOL_ACTION_KIND[step.toolName]) || 'other'
  }
  return undefined
}

/**
 * 步骤只带创建时间，没有结束时间。所以一截的耗时按「从它第一步开始，到下一件事发生为止」算——
 * 下一步的创建时间就是这一截的收尾时刻，段内只有一步时也才有耗时可言。
 * 后面没有步骤了（任务就此结束）只能退回最后一步的开始时间，会少算最后一步自己跑了多久。
 */
function toFold(steps: ProcessStepLike[], nextStepAt?: number): ProcessFoldView {
  const last = steps[steps.length - 1]
  const live = steps.some(isUnfinished)
  const startedAt = steps[0].timestamp
  const endedAt = nextStepAt ?? last.timestamp
  const elapsed =
    startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : 0
  return {
    // 只认这一截的起点：这截还在长，末尾每加一步 id 都变的话，
    // 用户刚点开就会被重新收起，虚拟列表也要跟着重建。
    id: `fold_${steps[0].id}`,
    counts: countActions(steps),
    live,
    liveText: live ? extractProgressLine(steps) : undefined,
    liveAction: live ? pendingAction(steps) : undefined,
    startedAt,
    durationMs: !live && elapsed >= MIN_SHOWN_DURATION_MS ? elapsed : undefined,
    stepIds: steps.map(step => step.id),
  }
}

/**
 * 把步骤流切成「留在外面的」和「收成一行的」。
 *
 * 收是从头收到尾——不是做完才收，而是压根没展开过，所以任务跑着的时候
 * 只有那一行在动，做完也不会有十几行忽然塌成一行的突变。
 */
export function foldProcessSteps(
  steps: ReadonlyArray<ProcessStepLike>,
  opts: { enabled: boolean },
): ProcessSegment[] {
  if (steps.length === 0) return []
  if (!opts.enabled) return [{ kind: 'open', steps: [...steps] }]

  const runs: { pinned: boolean; steps: ProcessStepLike[] }[] = []
  for (const step of steps) {
    const pinned = isPinnedProcessStep(step)
    const last = runs[runs.length - 1]
    if (last && last.pinned === pinned) last.steps.push(step)
    else runs.push({ pinned, steps: [step] })
  }

  return runs.map((run, i) => {
    if (run.pinned) return { kind: 'open' as const, steps: run.steps }
    const nextStepAt = runs[i + 1]?.steps[0]?.timestamp
    return { kind: 'fold' as const, fold: toFold(run.steps, nextStepAt), steps: run.steps }
  })
}
