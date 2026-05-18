/**
 * Composer「引用摘录」：输入框仅展示胶囊摘要，发送时再附带带行号的完整正文。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ComposerQuoteSnippet {
  id: string
  /** 胶囊展示用短文件名 */
  label: string
  /** 绝对路径（发给模型）；无则为 null */
  sourcePath: string | null
  /** canvas 编辑区为 true（文件绝对行号）；预览/终端为 false */
  sourceLinesAccurate: boolean
  startLine: number | null
  endLine: number | null
  /** 摘录原文 */
  excerpt: string
  /** 终端右键选区为 terminal，侧栏 Markdown 为 canvas（默认） */
  quoteOrigin?: 'canvas' | 'terminal'
}

const snippetsByTabId = ref<Record<string, ComposerQuoteSnippet[]>>({})

export const useComposerQuoteStore = defineStore('composerQuote', () => {
  function getSnippets(tabId: string): ComposerQuoteSnippet[] {
    return snippetsByTabId.value[tabId] ?? []
  }

  function addSnippet(tabId: string, snippet: Omit<ComposerQuoteSnippet, 'id'> & { id?: string }) {
    const id = snippet.id ?? `q-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const cur = snippetsByTabId.value[tabId] ?? []
    snippetsByTabId.value = {
      ...snippetsByTabId.value,
      [tabId]: [
        ...cur,
        {
          id,
          label: snippet.label,
          sourcePath: snippet.sourcePath,
          sourceLinesAccurate: snippet.sourceLinesAccurate,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          excerpt: snippet.excerpt,
          quoteOrigin: snippet.quoteOrigin ?? 'canvas'
        }
      ]
    }
  }

  function removeSnippet(tabId: string, id: string) {
    const cur = snippetsByTabId.value[tabId] ?? []
    snippetsByTabId.value = {
      ...snippetsByTabId.value,
      [tabId]: cur.filter((s) => s.id !== id)
    }
  }

  function clearSnippets(tabId: string) {
    if (!(tabId in snippetsByTabId.value)) return
    const next = { ...snippetsByTabId.value }
    delete next[tabId]
    snippetsByTabId.value = next
  }

  return {
    snippetsByTabId,
    getSnippets,
    addSnippet,
    removeSnippet,
    clearSnippets
  }
})
