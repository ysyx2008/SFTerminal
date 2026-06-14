/**
 * 产出物渲染器 UI 注册表（Vue 组件 + 图标）
 *
 * 能力元数据来自 `renderers/registry.ts`。
 */
import { defineAsyncComponent, type Component } from 'vue'
import { FileText, Table2, FileCode, FileCode2, Image, Globe, FileType } from 'lucide-vue-next'
import type { CanvasRendererType } from '@shared/types'
import {
  getRendererCapabilities,
  type RendererCapabilities
} from './registry'

export interface RendererUiDescriptor extends RendererCapabilities {
  component: Component | null
  icon: Component
}

const DocumentRenderer = defineAsyncComponent(() => import('../components/DocumentRenderer.vue'))
const SpreadsheetRenderer = defineAsyncComponent(() => import('../components/SpreadsheetRenderer.vue'))
const MarkdownRenderer = defineAsyncComponent(() => import('../components/MarkdownRenderer.vue'))
const HtmlRenderer = defineAsyncComponent(() => import('../components/HtmlRenderer.vue'))

const UI_REGISTRY: Record<CanvasRendererType, Omit<RendererUiDescriptor, keyof RendererCapabilities>> = {
  document: { component: DocumentRenderer, icon: FileText },
  spreadsheet: { component: SpreadsheetRenderer, icon: Table2 },
  markdown: { component: MarkdownRenderer, icon: FileCode },
  html: { component: HtmlRenderer, icon: FileCode2 },
  browser: { component: null, icon: Globe },
  image: { component: null, icon: Image },
  pdf: { component: null, icon: FileType }
}

export function getRendererUi(type: CanvasRendererType): RendererUiDescriptor {
  const caps = getRendererCapabilities(type)
  const ui = UI_REGISTRY[type]
  return { ...caps, ...ui }
}

export function getRendererComponent(type: CanvasRendererType): Component | null {
  return getRendererUi(type).component
}

export function getRendererIcon(type: CanvasRendererType): Component {
  return getRendererUi(type).icon
}
