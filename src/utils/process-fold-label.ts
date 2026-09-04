import { ACTION_KIND_ORDER, type ActionKind, type LiveProcessView } from './process-fold'

export interface ProcessFoldSay {
  working: string
  thinking: string
  thought: string
  colleagues: (n: number) => string
  doing: (kind: ActionKind) => string
  counted: (kind: ActionKind, n: number) => string
  sep: string
}

export function processFoldActionLine(
  counts: LiveProcessView['counts'],
  say: ProcessFoldSay,
): string {
  const parts: string[] = []
  for (const kind of ACTION_KIND_ORDER) {
    const n = counts[kind] || 0
    if (n > 0) parts.push(say.counted(kind, n))
  }
  return parts.join(say.sep)
}

export function processFoldLiveCaption(
  view: LiveProcessView,
  say: ProcessFoldSay,
  shownLiveText = view.liveText,
): { label: string; trailing: string } {
  const actionLine = processFoldActionLine(view.counts, say)
  if (shownLiveText) return { label: shownLiveText, trailing: actionLine }
  if (view.liveColleagueCount) return { label: say.colleagues(view.liveColleagueCount), trailing: actionLine }
  if (view.liveAction) return { label: say.doing(view.liveAction), trailing: actionLine }
  return {
    label: view.thinkingOnly ? say.thinking : say.working,
    trailing: actionLine,
  }
}

export function formatProcessFoldCaption(
  view: LiveProcessView,
  say: ProcessFoldSay,
  shownLiveText = view.liveText,
): string {
  const { label, trailing } = processFoldLiveCaption(view, say, shownLiveText)
  return trailing ? `${label}${say.sep}${trailing}` : label
}
