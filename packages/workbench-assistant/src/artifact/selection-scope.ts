/**
 * Markdown 选区作用域登记：发送时由岗壳静默取出交给 AI，不进 Composer 引用胶囊。
 *
 * 依赖方向：workbench-assistant 登记；AssistantWorkbench 在发送前 consume；
 * src 侧 AiPanel/AiComposer 只接收回调结果，不反向依赖本包。
 */
import type { ArtifactComposerQuote } from './composer-quote'

export interface SelectionScopeProvider {
  /** 当前 sticky/活选区；无选区返回 null */
  getScope: () => ArtifactComposerQuote | null
  /** 发送后清除编辑器 sticky，避免下一条误带旧选区 */
  clearScope: () => void
}

const providersByTabId = new Map<string, SelectionScopeProvider>()

/** MarkdownRenderer 挂载时登记；返回反登记函数 */
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
 * 发送前消费选区作用域：取出后立即 clear，保证一次性。
 * 无登记或无选区时返回 null。
 */
export function consumeSelectionScope(tabId: string): ArtifactComposerQuote | null {
  const scope = readScope(tabId)
  if (!scope) return null
  providersByTabId.get(tabId)?.clearScope()
  return scope
}
