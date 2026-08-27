import { ref } from 'vue'
import { selectionAnchorBox, type ContextMenuBox } from '../domain/context-menu-position'

/**
 * 选区提示的开关与锚点。Word/WPS 预览与 Markdown 编辑器共用一套，
 * 免得两边各写一份、改行为漏改一边。
 * Excel 预览没有原生文字选区，可传入 getAnchor 用圈中的格子外框。
 */
export function useSelectionActionHint(
  getRoot: () => Node | null,
  getAnchor?: () => ContextMenuBox | null
) {
  /** 提示锚点（选区外框）；null = 不显示 */
  const anchor = ref<ContextMenuBox | null>(null)

  function show() {
    anchor.value = getAnchor ? getAnchor() : selectionAnchorBox(getRoot())
  }

  function hide() {
    anchor.value = null
  }

  /** 选区被拉长/挪动时跟着走；本来没显示就不要因此冒出来（拖选途中不闪） */
  function refresh() {
    if (anchor.value) show()
  }

  /**
   * 用户开始往输入框里写要求时收起提示。
   * 复制（修饰键组合）与纯光标移动不算输入——选完顺手复制不该让提示消失。
   */
  function hideOnTyping(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const editing = e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete'
    if (!editing) return
    hide()
  }

  return { anchor, show, hide, refresh, hideOnTyping }
}
