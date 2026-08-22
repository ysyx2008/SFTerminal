import { inferConversationKind } from '@shared/types'
import type { CueSoundKind } from '@shared/types'

function kindsOf(agentKeys: Array<string | undefined>): Set<ReturnType<typeof inferConversationKind>> {
  const out = new Set<ReturnType<typeof inferConversationKind>>()
  for (const key of agentKeys) {
    if (key) out.add(inferConversationKind(key))
  }
  return out
}

function isBackgroundOnly(kinds: Set<ReturnType<typeof inferConversationKind>>): boolean {
  if (kinds.size === 0) return true
  return [...kinds].every(k => k === 'watch' || k === 'wakeup')
}

/** 任务顺利结束该响哪一声；不该响则返回 null（点停 / 关切 / 唤醒） */
export function resolveCompleteCueKind(
  agentKeys: Array<string | undefined>,
  aborted?: boolean,
): CueSoundKind | null {
  if (aborted) return null
  const kinds = kindsOf(agentKeys)
  if (isBackgroundOnly(kinds)) return null
  if (kinds.has('companion')) return null
  return 'complete'
}

export function shouldPlayFailedCue(agentKeys: Array<string | undefined>): boolean {
  return !isBackgroundOnly(kindsOf(agentKeys))
}

export function shouldPlayConfirmCue(agentKeys: Array<string | undefined>): boolean {
  return !isBackgroundOnly(kindsOf(agentKeys))
}
