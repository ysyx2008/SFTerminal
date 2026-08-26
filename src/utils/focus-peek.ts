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
