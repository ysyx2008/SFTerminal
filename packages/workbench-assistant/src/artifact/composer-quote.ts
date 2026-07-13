import type { InjectionKey } from 'vue'

/** 产出物引用到 Composer 的摘录（与桌面 ComposerQuoteSnippet 字段对齐，不含 id） */
export interface ArtifactComposerQuote {
  label: string
  sourcePath: string | null
  sourceLinesAccurate: boolean
  startLine: number | null
  endLine: number | null
  excerpt: string
  quoteOrigin?: 'canvas' | 'terminal'
}

export type AddComposerQuoteFn = (snippet: ArtifactComposerQuote) => void

/** ArtifactPanel provide → MarkdownRenderer inject */
export const ADD_COMPOSER_QUOTE_KEY: InjectionKey<AddComposerQuoteFn> = Symbol('addComposerQuote')
