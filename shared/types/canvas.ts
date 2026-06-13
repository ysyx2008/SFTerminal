/**
 * Canvas Artifact 面板类型定义
 *
 * Canvas 是独立助手右侧的产出物工作区：Agent 产出文件/文档时在面板注册 Artifact，
 * 用户可在多个产出物之间切换查看。
 */

/** Canvas 渲染器类型 */
export type CanvasRendererType =
  | 'document'      // Word HTML 预览
  | 'spreadsheet'   // Excel 表格预览
  | 'browser'       // 浏览器截图（预留）
  | 'image'         // 图片展示（预留）
  | 'html'          // 通用 HTML（沙盒 iframe，如 PPT 预览）
  | 'markdown'      // Markdown 渲染
  | 'pdf'           // PDF 预览（预留）

/** Canvas 打开事件 */
export interface CanvasOpenPayload {
  tabId: string
  renderer: CanvasRendererType
  title: string
}

/** Canvas 内容更新事件 */
export interface CanvasUpdatePayload {
  tabId: string
  data: string
  highlights?: CanvasHighlight[]
}

/** Canvas 关闭事件 */
export interface CanvasClosePayload {
  tabId: string
}

/** 文档变更高亮 */
export interface CanvasHighlight {
  range: string
  type: 'added' | 'modified' | 'deleted'
}

/** 单个 Canvas 产出物 */
export interface CanvasArtifact {
  id: string
  renderer: CanvasRendererType
  title: string
  /** HTML / Markdown 源码等 */
  content: string
  /** 磁盘锚点（绝对路径） */
  filePath?: string | null
  createdAt: number
  updatedAt: number
  pinned?: boolean
}

/** 定位已有 artifact 的键（open 之外的 action 使用） */
export type CanvasArtifactTarget = Partial<Pick<CanvasData, 'artifactId' | 'filePath' | 'renderer'>>

/**
 * AgentStep 中附带的 Canvas 数据
 * 搭 agent:step IPC 便车，由前端 canvas registry 消费
 */
export interface CanvasData {
  action: 'open' | 'update' | 'close'
  renderer: CanvasRendererType
  title?: string
  content?: string
  filePath?: string
  artifactId?: string
  /** open 时是否切换到该 tab，默认 true */
  activate?: boolean
}

/** 由 CanvasData 推导稳定 Artifact ID（open / upsert 用） */
export function resolveCanvasArtifactId(
  data: Pick<CanvasData, 'artifactId' | 'filePath' | 'renderer' | 'title'>
): string {
  if (data.artifactId) return data.artifactId
  if (data.filePath) return `file:${data.filePath}`
  const title = (data.title || 'untitled').trim()
  return `ephemeral:${data.renderer}:${title}`
}
