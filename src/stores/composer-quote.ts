/**
 * 将「选中段落」推送到指定 Tab 的 AiComposer（右侧 Canvas 等跨组件调用）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useComposerQuoteStore = defineStore('composerQuote', () => {
  /** 递增以触发 AiPanel 中的 watch */
  const injectSignal = ref(0)
  const pending = ref<{ tabId: string; text: string } | null>(null)

  function requestQuoteToComposer(tabId: string, text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    pending.value = { tabId, text: trimmed }
    injectSignal.value++
  }

  function peekForTab(tabId: string): { text: string } | null {
    const p = pending.value
    if (!p || p.tabId !== tabId) return null
    return { text: p.text }
  }

  function clearPayload() {
    pending.value = null
  }

  return {
    injectSignal,
    pending,
    requestQuoteToComposer,
    peekForTab,
    clearPayload
  }
})
