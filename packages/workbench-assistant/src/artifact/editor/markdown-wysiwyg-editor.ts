/**
 * Markdown 真 WYSIWYG 编辑器（Milkdown Crepe 封装）
 *
 * Typora 式所见即所得：表格/代码块/数学公式可视化编辑，无语法符号、无模式切换。
 * 结构性代价是「保存即规范化」——getMarkdown() 序列化输出 ≠ 原文件字节，
 * 调用方（MarkdownRenderer）以「基线恒为规范化内容」契约消化这一点。
 *
 * @see packages/workbench-assistant/src/artifact/SPEC.md「设计目标：编辑器形态」
 */
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { $prose, getMarkdown, replaceAll } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame-dark.css'

export interface MarkdownWysiwygQuote {
  excerpt: string
  /** WYSIWYG 选区无法映射源文件行号，恒为 false（Agent 走内容锚定） */
  accurate: false
  startLine: null
  endLine: null
}

export interface MarkdownWysiwygHandle {
  /** 程序化替换全文（触发一次 onDocChanged，由调用方按「外部内容」流程消化） */
  setContent: (markdown: string) => void
  /** 当前文档的规范化序列化 */
  getContent: () => string
  /**
   * 当前选区摘录（序列化为 markdown 切片）。
   * 焦点移出编辑器后仍可读：优先活选区，否则回退到失焦前缓存的非空选区。
   */
  getQuoteMeta: () => MarkdownWysiwygQuote | null
  focus: () => void
  /** 清除 sticky 选区（发送作用域后调用，避免下一条误带） */
  clearStickySelection: () => void
  destroy: () => void
  /** 编辑器根容器（右键菜单等事件挂在它上面） */
  dom: HTMLElement
  /** @internal 测试用：按文档中首次出现的原文设置选区 */
  selectTextForTest?: (substring: string) => boolean
}

const stickySelectionKey = new PluginKey<{ from: number; to: number } | null>('sf-sticky-selection')

/**
 * 失焦后浏览器会清掉原生 ::selection 高亮，但 ProseMirror 选区通常仍在。
 * 用 decoration 在未聚焦时画出同等高亮；并缓存最近非空选区，供 getQuoteMeta 在偶发清空后回退。
 */
function createStickySelectionPlugin(): Plugin {
  return new Plugin({
    key: stickySelectionKey,
    state: {
      init() {
        return null
      },
      apply(tr: Transaction, value: { from: number; to: number } | null, _old: EditorState, state: EditorState) {
        if (tr.getMeta(stickySelectionKey) === 'clear') return null
        const sel = state.selection
        if (!sel.empty) {
          return { from: sel.from, to: sel.to }
        }
        // 用户在编辑器内点空白折叠选区 → 清缓存；文档被整篇替换也清
        if (tr.selectionSet || tr.docChanged) {
          return null
        }
        return value
      }
    },
    props: {
      decorations(state) {
        const sel = state.selection
        const range = !sel.empty ? { from: sel.from, to: sel.to } : stickySelectionKey.getState(state)
        if (!range || range.from === range.to) return null
        // 聚焦时由原生 ::selection 负责，避免双重叠色（CSS 在 .ProseMirror-focused 下隐藏本 class）
        return DecorationSet.create(state.doc, [
          Decoration.inline(range.from, range.to, { class: 'sf-sticky-selection' })
        ])
      }
    }
  })
}

function quoteFromRange(ctx: any, from: number, to: number): MarkdownWysiwygQuote | null {
  if (from === to) return null
  const excerpt = getMarkdown({ from, to })(ctx).trim()
  if (!excerpt) return null
  return { excerpt, accurate: false, startLine: null, endLine: null }
}

export async function createMarkdownWysiwygEditor(options: {
  parent: HTMLElement
  doc: string
  onDocChanged: (markdown: string) => void
  /** 相对路径图片 → 可加载 URL（sailfish-artifact:// 协议映射） */
  resolveImageSrc?: (src: string) => string
  /** 界面语言：占位符与 TopBar 标题选项 */
  locale?: 'zh-CN' | 'en-US'
}): Promise<MarkdownWysiwygHandle> {
  const isZh = options.locale !== 'en-US'
  const crepe = new Crepe({
    root: options.parent,
    defaultValue: options.doc,
    features: {
      // TopBar 固定格式栏开启（默认关闭）；AI 特性关闭（Agent 外部驱动）；
      // 选区悬浮 Toolbar 关闭（面板已有 TopBar + 右键菜单，悬浮框遮挡且样式不统一）
      [Crepe.Feature.TopBar]: true,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.Toolbar]: false
    },
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: {
        proxyDomURL: (src: string) => options.resolveImageSrc?.(src) ?? src
      },
      [Crepe.Feature.Placeholder]: {
        text: isZh ? '请输入…' : 'Please enter...',
        mode: 'doc'
      },
      [Crepe.Feature.Cursor]: {
        // 关闭虚拟光标，用浏览器原生 caret，避免闪烁时颜色/样式不一致
        virtual: false
      },
      [Crepe.Feature.TopBar]: {
        headingOptions: isZh
          ? [
              { label: '正文', level: null },
              { label: '标题 1', level: 1 },
              { label: '标题 2', level: 2 },
              { label: '标题 3', level: 3 },
              { label: '标题 4', level: 4 },
              { label: '标题 5', level: 5 },
              { label: '标题 6', level: 6 }
            ]
          : undefined
      }
    }
  })

  crepe.editor.use($prose(() => createStickySelectionPlugin()))

  await crepe.create()

  /** destroy 后忽略 listener，防止 Crepe 清空文档时把空串回灌给调用方 */
  let disposed = false
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      if (disposed) return
      options.onDocChanged(markdown)
    })
  })

  return {
    setContent(markdown: string) {
      if (disposed) return
      crepe.editor.action(replaceAll(markdown))
    },
    getContent() {
      if (disposed) return ''
      return crepe.getMarkdown()
    },
    getQuoteMeta() {
      if (disposed) return null
      let quote: MarkdownWysiwygQuote | null = null
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const { from, to, empty } = view.state.selection
        if (!empty) {
          quote = quoteFromRange(ctx, from, to)
          return
        }
        const cached = stickySelectionKey.getState(view.state)
        if (cached) {
          quote = quoteFromRange(ctx, cached.from, cached.to)
        }
      })
      return quote
    },
    focus() {
      if (disposed) return
      crepe.editor.action((ctx) => {
        ctx.get(editorViewCtx).focus()
      })
    },
    clearStickySelection() {
      if (disposed) return
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const head = view.state.selection.head
        const tr = view.state.tr
          .setSelection(TextSelection.near(view.state.doc.resolve(head)))
          .setMeta(stickySelectionKey, 'clear')
        view.dispatch(tr)
      })
    },
    destroy() {
      disposed = true
      void crepe.destroy()
    },
    dom: options.parent,
    selectTextForTest(substring: string) {
      if (disposed || !substring) return false
      let ok = false
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const { doc } = view.state
        let from = -1
        let to = -1
        doc.descendants((node, pos) => {
          if (from >= 0) return false
          if (!node.isText || !node.text) return
          const idx = node.text.indexOf(substring)
          if (idx < 0) return
          from = pos + idx
          to = from + substring.length
          return false
        })
        if (from < 0 || to < 0) return
        view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)))
        ok = true
      })
      return ok
    }
  }
}
