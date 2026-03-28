/**
 * Canvas 预览面板类型定义
 * 
 * Canvas 是独立助手右侧的动态预览面板，Agent 执行工具时自动展示相关内容，
 * 增加执行透明度。
 */

/** Canvas 渲染器类型 */
export type CanvasRendererType =
  | 'terminal'      // xterm.js 命令执行展示
  | 'document'      // Word HTML 预览
  | 'spreadsheet'   // Excel 表格预览
  | 'browser'       // 浏览器截图
  | 'image'         // 图片展示
  | 'html'          // 通用 HTML（沙盒 iframe）
  | 'markdown'      // Markdown 渲染
  | 'pdf'           // PDF 预览

/** Canvas 打开事件 */
export interface CanvasOpenPayload {
  tabId: string
  renderer: CanvasRendererType
  title: string
}

/** Canvas 内容更新事件（终端数据、文档内容等） */
export interface CanvasUpdatePayload {
  tabId: string
  /** 写入 xterm / 替换 HTML 等 */
  data: string
  /** 可选：对于文档类型，标记变更区域 */
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

/**
 * AgentStep 中附带的 Canvas 数据
 * 搭 agent:step IPC 便车，由前端 canvas store 消费
 */
export interface CanvasData {
  action: 'open' | 'update' | 'close'
  renderer: CanvasRendererType
  title?: string
  /** HTML 内容（Word 文档 / Excel 表格） */
  content?: string
}
