/**
 * 文档铺满时，对话退成一句提醒。口径跟过程折叠同一套：
 * 它说出口的话、它在忙什么、要你动手——不另写摘要。
 */
import { parseThinking } from './thinking-block'

export type FocusPeekKind = 'none' | 'spoken' | 'busy'

export interface FocusPeek {
  kind: FocusPeekKind
  text: string
}

export interface FocusPeekStepLike {
  type: string
  content?: string
}

export function lastSpokenBody(steps: ReadonlyArray<FocusPeekStepLike>): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'message') continue
    const body = parseThinking(step.content || '').body.trim()
    if (body) return body
  }
  return ''
}

export function resolveFocusPeek(input: {
  needsYou: boolean
  isRunning: boolean
  liveText?: string
  spoken?: string
}): FocusPeek {
  if (input.needsYou) return { kind: 'none', text: '' }
  if (input.isRunning) {
    return { kind: 'busy', text: (input.liveText || '').trim() }
  }
  const spoken = (input.spoken || '').trim()
  if (spoken) return { kind: 'spoken', text: spoken }
  return { kind: 'none', text: '' }
}

/** 铺满浮层里的过程条目：折叠行，或尚未收进折叠的思考/工具 */
export interface PeekProcessItem {
  id: string
  type: string
  fold?: { id?: string; live?: boolean }
}

/**
 * 运行中只留当前这一截：还在跑的那一行过程。
 * 前面已经收起来的折叠不摊开；没有折叠时只留末尾还在动的那一步。
 */
export function pickPeekProcessItems<T extends PeekProcessItem>(
  items: readonly T[],
  running: boolean,
): T[] {
  if (!running || items.length === 0) return []

  const liveFold = [...items].reverse().find(item =>
    item.type === 'folded_turn' && item.fold?.live,
  )
  if (liveFold) return [liveFold]

  let lastFold = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === 'folded_turn') lastFold = i
  }
  if (lastFold < 0) return [items[items.length - 1]]

  const trailing = items.slice(lastFold + 1)
  if (trailing.length) return trailing
  // 提问把上一截收掉之后，在新步骤到来前不要把已结束的那一行再当成过程
  return []
}

/** 铺满过程卡只用还在跑的那一行；已结束的折叠走回活的过程。 */
export function pickPeekLiveFold<T extends PeekProcessItem>(items: readonly T[]): T | null {
  return [...items].reverse().find(item =>
    item.type === 'folded_turn' && item.fold?.live,
  ) ?? null
}

export type PeekSurface = 'needs-you' | 'process' | 'spoken' | 'none'

/** 要你动手的完整块：确认、密码、还能答的提问。有一块算一块。 */
export function countPeekNeedsYou(input: {
  interactiveAskCount: number
  hasConfirm?: boolean
  hasSecure?: boolean
}): number {
  return input.interactiveAskCount
    + (input.hasConfirm ? 1 : 0)
    + (input.hasSecure ? 1 : 0)
}

/**
 * 铺满时文档上只能出现一种浮层。
 * 运行中过程行还没接上，也要留着过程，不能把卡片收掉。
 */
export function resolvePeekSurface(input: {
  needsYou: boolean
  needsYouCount: number
  processCount: number
  kind: FocusPeekKind
  isRunning?: boolean
}): PeekSurface {
  if (input.needsYou && input.needsYouCount > 0) return 'needs-you'
  if (input.processCount > 0 || input.kind === 'busy' || input.isRunning) return 'process'
  if (input.kind === 'spoken') return 'spoken'
  return 'none'
}

const PEEK_LIVE_PINS = new Set(['asking', 'waiting_password', 'waiting_input', 'waiting'])

/** 提问/密码/等待把上一截钉住之后，活着的过程从那之后算。 */
export function pickPeekLiveSteps<T extends { type: string }>(steps: readonly T[]): T[] {
  let pin = -1
  for (let i = 0; i < steps.length; i++) {
    if (PEEK_LIVE_PINS.has(steps[i].type)) pin = i
  }
  return pin >= 0 ? steps.slice(pin + 1) : [...steps]
}

/** 过程卡片点开后要看到的步骤：这一次动手的思考和工具，不含提问和它说出口的话。 */
export function pickPeekExpandSteps<T extends { type: string }>(steps: readonly T[]): T[] {
  return steps.filter(step =>
    step.type === 'thinking' ||
    step.type === 'tool_call' ||
    step.type === 'tool_result'
  )
}

/** 文档给浮层让出的高度：量不到就留一条输入的位置。 */
export function overlayReservePx(measuredHeight?: number): number {
  if (!measuredHeight || measuredHeight <= 0) return 160
  return Math.max(120, Math.ceil(measuredHeight))
}

/** 铺满过程卡一次算完：列表里的活折叠、提问之后的步骤、点开要看的步骤。 */
export function buildPeekProcessView<
  S extends { id?: string; type: string },
  I extends PeekProcessItem,
>(input: {
  isRunning: boolean
  steps: readonly S[]
  items: readonly I[]
}) {
  const items = pickPeekProcessItems(input.items, input.isRunning)
  return {
    items,
    liveFold: pickPeekLiveFold(items),
    liveSteps: pickPeekLiveSteps(input.steps),
    expandSteps: pickPeekExpandSteps(input.steps),
  }
}

/** 铺满浮层一次算完：提问、过程、做完那句，执行中不能空。 */
export function resolvePeekOverlay(input: {
  needsYou: boolean
  needsYouCount: number
  processCount: number
  isRunning: boolean
  liveText?: string
  spoken?: string
}): PeekSurface {
  const kind = resolveFocusPeek({
    needsYou: input.needsYou,
    isRunning: input.isRunning,
    liveText: input.liveText,
    spoken: input.spoken,
  }).kind
  return resolvePeekSurface({
    needsYou: input.needsYou,
    needsYouCount: input.needsYouCount,
    processCount: input.processCount,
    kind,
    isRunning: input.isRunning,
  })
}
