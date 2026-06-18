/**
 * 产出物渲染器能力注册表（纯函数，无 Vue 依赖）
 *
 * 新增 renderer 类型时在此声明 editable / saveStrategy / defaultExt；
 * UI 组件映射见 `renderers/ui-registry.ts`。
 */
import type { CanvasArtifact, CanvasRendererType } from '@shared/types'

export type RendererSaveStrategy = 'write' | 'copy' | 'none'

export interface RendererCapabilities {
  type: CanvasRendererType
  editable: boolean
  saveStrategy: RendererSaveStrategy
  defaultExt: string
}

const REGISTRY: Record<CanvasRendererType, RendererCapabilities> = {
  document: { type: 'document', editable: false, saveStrategy: 'copy', defaultExt: '.docx' },
  spreadsheet: { type: 'spreadsheet', editable: false, saveStrategy: 'copy', defaultExt: '.xlsx' },
  browser: { type: 'browser', editable: false, saveStrategy: 'none', defaultExt: '' },
  image: { type: 'image', editable: false, saveStrategy: 'copy', defaultExt: '' },
  html: { type: 'html', editable: false, saveStrategy: 'copy', defaultExt: '.html' },
  markdown: { type: 'markdown', editable: true, saveStrategy: 'write', defaultExt: '.md' },
  pdf: { type: 'pdf', editable: false, saveStrategy: 'copy', defaultExt: '.pdf' }
}

export function getRendererCapabilities(type: CanvasRendererType): RendererCapabilities {
  return REGISTRY[type]
}

export function isRendererEditable(type: CanvasRendererType): boolean {
  return REGISTRY[type].editable
}

export function saveExtensionForRenderer(type: CanvasRendererType): string {
  return REGISTRY[type].defaultExt
}

/** 兼容旧数据：优先读 artifact.editable，否则查注册表 */
export function isArtifactEditable(artifact: Pick<CanvasArtifact, 'renderer' | 'editable'>): boolean {
  return artifact.editable ?? isRendererEditable(artifact.renderer)
}

export function getArtifactSaveStrategy(
  artifact: Pick<CanvasArtifact, 'renderer'>
): RendererSaveStrategy {
  return getRendererCapabilities(artifact.renderer).saveStrategy
}
