/**
 * 产出物选区作用域登记：发送时由岗壳静默取出交给 AI，不进 Composer 引用胶囊。
 *
 * 依赖方向：workbench-assistant 登记；AssistantWorkbench 在发送前 consume；
 * src 侧 AiPanel/AiComposer 只接收回调结果，不反向依赖本包。
 */
import type { ArtifactComposerQuote } from './composer-quote'

export interface SelectionScopeProvider {
  /** 当前 sticky/活选区；无选区返回 null */
  getScope: () => ArtifactComposerQuote | null
  /** 清除 sticky。发送时是否调用取决于 retainAfterConsume */
  clearScope: () => void
  /** 发送后仍保留选区（Excel 要留着对照格子）。默认 false */
  retainAfterConsume?: boolean
}

const providersByTabId = new Map<string, SelectionScopeProvider>()

/** 当前预览/编辑器挂载时登记；返回反登记函数 */
export function registerSelectionScopeProvider(
  tabId: string,
  provider: SelectionScopeProvider
): () => void {
  providersByTabId.set(tabId, provider)
  return () => {
    if (providersByTabId.get(tabId) === provider) {
      providersByTabId.delete(tabId)
    }
  }
}

function readScope(tabId: string): ArtifactComposerQuote | null {
  const scope = providersByTabId.get(tabId)?.getScope() ?? null
  return scope?.excerpt.trim() ? scope : null
}

/** 只读查看当前选区（不清除） */
export function peekSelectionScope(tabId: string): ArtifactComposerQuote | null {
  return readScope(tabId)
}

/**
 * 发送前消费选区作用域：默认取出后立即 clear。
 * Excel 等标记 retainAfterConsume 的预览不清，方便对照，下一条仍针对同一块。
 * 无登记或无选区时返回 null。
 */
export function consumeSelectionScope(tabId: string): ArtifactComposerQuote | null {
  const scope = readScope(tabId)
  if (!scope) return null
  const provider = providersByTabId.get(tabId)
  if (!provider?.retainAfterConsume) provider?.clearScope()
  return scope
}
