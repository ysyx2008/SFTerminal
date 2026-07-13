import { onUnmounted, ref } from 'vue'

/**
 * 产出物包内 HoverTip（刻意不经 SDK）。
 * 与 desktop `src/composables/useHoverTip.ts` 为独立副本；修 bug 时请两边对齐。
 */

export type HoverTipPlacement = 'left' | 'top' | 'bottom'

export interface HoverTipState {
  text: string
  x: number
  y: number
  placement: HoverTipPlacement
}

export interface HoverTipShowOptions {
  placement?: HoverTipPlacement
  /** 0 = 即时；按钮建议 500–700ms */
  delayMs?: number
}

export interface UseHoverTipOptions {
  placement?: HoverTipPlacement
  delayMs?: number
}

function resolveOptions(
  defaults: UseHoverTipOptions,
  override?: HoverTipPlacement | HoverTipShowOptions
): Required<HoverTipShowOptions> {
  if (typeof override === 'string') {
    return { placement: override, delayMs: defaults.delayMs ?? 0 }
  }
  return {
    placement: override?.placement ?? defaults.placement ?? 'left',
    delayMs: override?.delayMs ?? defaults.delayMs ?? 0
  }
}

function computeTipPosition(
  el: HTMLElement,
  placement: HoverTipPlacement
): Pick<HoverTipState, 'x' | 'y' | 'placement'> {
  const rect = el.getBoundingClientRect()
  let x = rect.left - 8
  let y = rect.top + rect.height / 2

  if (placement === 'top') {
    x = rect.left + rect.width / 2
    y = rect.top - 8
  } else if (placement === 'bottom') {
    x = rect.left + rect.width / 2
    y = rect.bottom + 8
  }

  return { x, y, placement }
}

export function useHoverTip(options: UseHoverTipOptions | HoverTipPlacement = 'left') {
  const defaults: UseHoverTipOptions = typeof options === 'string'
    ? { placement: options, delayMs: 0 }
    : options

  const hoverTip = ref<HoverTipState | null>(null)
  let showTimer: ReturnType<typeof setTimeout> | null = null

  function clearShowTimer() {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
  }

  function showTip(
    e: MouseEvent,
    text: string,
    override?: HoverTipPlacement | HoverTipShowOptions
  ) {
    const el = e.currentTarget as HTMLElement | null
    if (!el) return

    clearShowTimer()
    hoverTip.value = null

    const { placement, delayMs } = resolveOptions(defaults, override)
    const reveal = () => {
      showTimer = null
      hoverTip.value = { text, ...computeTipPosition(el, placement) }
    }

    if (delayMs <= 0) {
      reveal()
    } else {
      showTimer = setTimeout(reveal, delayMs)
    }
  }

  function hideTip() {
    clearShowTimer()
    hoverTip.value = null
  }

  onUnmounted(hideTip)

  return { hoverTip, showTip, hideTip }
}

/** 工具栏/图标按钮：延迟显示，避免误触即时弹出 */
export const BUTTON_HOVER_TIP_DELAY_MS = 650
