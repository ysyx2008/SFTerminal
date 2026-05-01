/**
 * 分屏管理工具执行器
 *
 * Agent 通过这些工具操作前端分屏布局：拆分、关闭、切换激活、列出窗格。
 * 实际的状态变更发生在前端 Pinia store 中，由 split-pane-bridge 提供反向 IPC。
 *
 * 命令路由约定：分屏后命令工具（execute_command 等）默认仍发到 Agent 创建时的初始 PTY。
 * 要在其他窗格执行，请在工具参数里显式传 pane_id（值为 list_panes 返回的 pty_id）。
 * focus_pane 仅切换前端 UI 焦点（让用户看到激活高亮），不影响命令路由。
 */
import { splitPaneBridge, type SplitPaneOp, type SplitPaneResult } from '../../split-pane-bridge.service'
import type { ToolResult } from './types'

function ok(output: string, data?: unknown): ToolResult {
  return { success: true, output: data === undefined ? output : `${output}\n${JSON.stringify(data, null, 2)}` }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

async function callBridge(op: SplitPaneOp): Promise<SplitPaneResult> {
  return splitPaneBridge.exec(op)
}

export async function splitTerminalTool(args: Record<string, unknown>): Promise<ToolResult> {
  const direction = (args as { direction?: unknown }).direction
  if (direction !== 'horizontal' && direction !== 'vertical') {
    return fail('direction 必须是 "horizontal" 或 "vertical"')
  }
  const result = await callBridge({ type: 'split', direction })
  if (!result.ok) return fail(result.error || '分屏失败')
  return ok(
    `已创建${direction === 'horizontal' ? '左右' : '上下'}分屏。后续如需在新窗格执行命令，请在 execute_command 等工具传入 pane_id（值为返回数据中新窗格的 ptyId）。`,
    result.data
  )
}

export async function closePaneTool(args: Record<string, unknown>): Promise<ToolResult> {
  const paneId = (args as { pane_id?: unknown }).pane_id ?? (args as { paneId?: unknown }).paneId
  if (typeof paneId !== 'string' || !paneId) {
    return fail('pane_id 必须为字符串')
  }
  const result = await callBridge({ type: 'close', paneId })
  if (!result.ok) return fail(result.error || '关闭窗格失败')
  return ok('已关闭窗格', result.data)
}

export async function focusPaneTool(args: Record<string, unknown>): Promise<ToolResult> {
  const paneId = (args as { pane_id?: unknown }).pane_id ?? (args as { paneId?: unknown }).paneId
  if (typeof paneId !== 'string' || !paneId) {
    return fail('pane_id 必须为字符串')
  }
  const result = await callBridge({ type: 'focus', paneId })
  if (!result.ok) return fail(result.error || '切换激活窗格失败')
  return ok(
    '已切换前端 UI 焦点。注意：这仅影响 UI 的高亮显示——要在该窗格执行命令，请在 execute_command 等工具的 pane_id 参数中传入该窗格的 pty_id。',
    result.data
  )
}

export async function listPanesTool(): Promise<ToolResult> {
  const result = await callBridge({ type: 'list' })
  if (!result.ok) return fail(result.error || '列出窗格失败')
  return ok('当前窗格列表（命令工具想在指定窗格执行时，传 pane_id 字段，值=该窗格的 ptyId）', result.data)
}
