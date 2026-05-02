/**
 * 分屏管理工具执行器
 *
 * Agent 通过这些工具操作前端分屏布局：拆分、关闭、切换激活、列出窗格。
 * 实际的状态变更发生在前端 Pinia store 中，由 split-pane-bridge 提供反向 IPC。
 *
 * 窗格标识约定：对 Agent 暴露的"窗格 id"统一为 ptyId——ptyId 在窗格生命周期内
 * 稳定不变。前端布局树内部还有"paneId"（布局节点 id），但它在 split 关闭兄弟
 * 触发层级压缩（liftChildIntoParent）时会被替换，旧值失效。所以工具参数 pane_id
 * 的语义就是 ptyId，list_panes 返回字段也只暴露 ptyId。
 *
 * 命令路由约定：分屏后命令工具（execute_command 等）默认仍发到 Agent 创建时的
 * 初始 PTY。要在其他窗格执行，请在工具参数里显式传 pane_id（值为目标窗格的
 * ptyId）。close_pane / focus_pane 在执行后会自动同步 Agent 的"当前默认窗格"。
 */
import { splitPaneBridge, type SplitPaneOp, type SplitPaneResult, type SplitTargetOp } from '../../split-pane-bridge.service'
import { getConfigService } from '../../config.service'
import type { ToolResult, ToolExecutorConfig } from './types'

/** handler 返回的 panes 项形态（与 split-pane-handler.ts::collectPanes 保持一致） */
interface PaneInfo {
  ptyId: string
  label: string
  isActive: boolean
  terminalType: string
}

/**
 * 根据 handler 返回的剩余窗格列表，挑一个新的"当前操作 ptyId"。
 * 优先取 isActive 的那个（前端 closePane 已自动切焦点）；都没有就取第一个。
 */
function pickFallbackPtyId(panes: PaneInfo[] | undefined): string | undefined {
  if (!panes || panes.length === 0) return undefined
  return panes.find(p => p.isActive)?.ptyId || panes[0]?.ptyId
}

function ok(output: string, data?: unknown): ToolResult {
  return { success: true, output: data === undefined ? output : `${output}\n${JSON.stringify(data, null, 2)}` }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

async function callBridge(op: SplitPaneOp, ownerPtyId?: string): Promise<SplitPaneResult> {
  return splitPaneBridge.exec(op, ownerPtyId)
}

/**
 * 解析 Agent 给的 target 参数。
 *
 * 支持几种宽松写法（LLM 可能用任意一种）：
 * - 不传 → undefined → 走 inherit
 * - "inherit" / "local"
 * - "ssh:<sessionId>"
 * - { kind: "inherit" | "local" }
 * - { kind: "ssh", sessionId: "..." }
 */
function parseSplitTarget(raw: unknown): SplitTargetOp | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s || s === 'inherit') return { kind: 'inherit' }
    if (s === 'local') return { kind: 'local' }
    if (s.startsWith('ssh:')) {
      const sessionId = s.slice(4).trim()
      if (!sessionId) return { error: 'target "ssh:..." 缺少 sessionId' }
      return { kind: 'ssh', sessionId }
    }
    return { error: `target 字符串只支持 "inherit" / "local" / "ssh:<sessionId>"，收到 "${s}"` }
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const kind = obj.kind
    if (kind === 'inherit') return { kind: 'inherit' }
    if (kind === 'local') return { kind: 'local' }
    if (kind === 'ssh') {
      const sessionId = obj.sessionId ?? obj.session_id
      if (typeof sessionId !== 'string' || !sessionId) {
        return { error: 'target.kind="ssh" 时必须提供 sessionId' }
      }
      return { kind: 'ssh', sessionId }
    }
  }

  return { error: 'target 格式无效' }
}

export async function splitTerminalTool(args: Record<string, unknown>, ownerPtyId?: string): Promise<ToolResult> {
  const direction = (args as { direction?: unknown }).direction
  if (direction !== 'horizontal' && direction !== 'vertical') {
    return fail('direction 必须是 "horizontal" 或 "vertical"')
  }

  const parsedTarget = parseSplitTarget(args.target)
  if (parsedTarget && typeof parsedTarget === 'object' && 'error' in parsedTarget) {
    return fail(parsedTarget.error)
  }
  const target = parsedTarget as SplitTargetOp | undefined

  const result = await callBridge({ type: 'split', direction, target }, ownerPtyId)
  if (!result.ok) return fail(result.error || '分屏失败')

  const targetDesc = target?.kind === 'ssh'
    ? `（连接到 SSH 会话 ${target.sessionId}）`
    : target?.kind === 'local'
      ? '（新开本地终端）'
      : ''

  return ok(
    `已创建${direction === 'horizontal' ? '左右' : '上下'}分屏${targetDesc}。后续如需在新窗格执行命令，请在 execute_command 等工具传入 pane_id（值为返回数据中新窗格的 ptyId——窗格标识统一用 ptyId）。`,
    result.data
  )
}

/**
 * 列出所有已配置的 SSH 会话，供 Agent 调用 split_terminal 时选择目标。
 *
 * 不返回密码 / 私钥路径等敏感字段，只暴露足够 Agent 决策的元信息。
 */
export async function listSshSessionsTool(): Promise<ToolResult> {
  const sessions = getConfigService().getSshSessions()
  const safe = sessions.map(s => ({
    sessionId: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    group: s.groupId || s.group
  }))
  return ok(
    `共 ${safe.length} 个已配置的 SSH 会话。调用 split_terminal 时把 sessionId 作为 target 传入即可在新窗格中连接对应主机：\n  - 字符串形式：target: "ssh:<sessionId>"\n  - 对象形式：target: { kind: "ssh", sessionId: "<sessionId>" }`,
    safe
  )
}

export async function closePaneTool(
  args: Record<string, unknown>,
  ownerPtyId?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  // pane_id 的语义就是目标窗格的 ptyId；同时容忍历史/同义字段名（pty_id / paneId / ptyId）。
  // store 内部对未知 id 也会按 ptyId 兜底查找，所以即使 LLM 给的不是规范命名也能正确路由。
  const paneId = (args as { pane_id?: unknown }).pane_id
    ?? (args as { pty_id?: unknown }).pty_id
    ?? (args as { paneId?: unknown }).paneId
    ?? (args as { ptyId?: unknown }).ptyId
  if (typeof paneId !== 'string' || !paneId) {
    return fail('pane_id 必须为字符串（值为目标窗格的 ptyId）')
  }
  const result = await callBridge({ type: 'close', ptyId: paneId }, ownerPtyId)
  if (!result.ok) return fail(result.error || '关闭窗格失败')

  // 如果关掉的就是 Agent 当前操作的窗格，自动把 currentPtyId 切到剩余某个，
  // 让后续 execute_command 等工具不必显式传 pane_id 也能继续工作。
  // 判定"是否关到了自己"的方式：ownerPtyId 不再出现在剩余窗格列表里。
  const data = result.data as { panes?: PaneInfo[] } | undefined
  const remaining = data?.panes
  if (ownerPtyId && remaining && !remaining.some(p => p.ptyId === ownerPtyId)) {
    const newPtyId = pickFallbackPtyId(remaining)
    if (newPtyId) {
      config?.setCurrentPtyId?.(newPtyId)
      return ok(
        `已关闭窗格，当前操作焦点已自动切换到剩余窗格（ptyId=${newPtyId}）。后续命令默认在新焦点执行。`,
        result.data
      )
    }
  }
  return ok('已关闭窗格', result.data)
}

export async function focusPaneTool(
  args: Record<string, unknown>,
  ownerPtyId?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const paneId = (args as { pane_id?: unknown }).pane_id
    ?? (args as { pty_id?: unknown }).pty_id
    ?? (args as { paneId?: unknown }).paneId
    ?? (args as { ptyId?: unknown }).ptyId
  if (typeof paneId !== 'string' || !paneId) {
    return fail('pane_id 必须为字符串（值为目标窗格的 ptyId）')
  }
  const result = await callBridge({ type: 'focus', ptyId: paneId }, ownerPtyId)
  if (!result.ok) return fail(result.error || '切换激活窗格失败')

  // 同步更新 Agent 的"当前默认操作 ptyId"——focus_pane 的语义就是切换操作焦点：
  // 既影响 UI，也影响后续命令工具的默认目标。Agent 不必每次都显式传 pane_id。
  // store.setActivePaneInTab 成功后激活窗格已被设为 paneId 对应的窗格，直接用入参即可。
  const data = result.data as { panes?: PaneInfo[] } | undefined
  const newPtyId = data?.panes?.find(p => p.isActive)?.ptyId
  if (newPtyId) {
    config?.setCurrentPtyId?.(newPtyId)
  }
  return ok(
    `已切换激活窗格${newPtyId ? `（当前操作焦点 ptyId=${newPtyId}）` : ''}。后续 execute_command 等工具默认在该窗格执行；如需在其他窗格执行可继续传 pane_id 显式指定（值为目标窗格的 ptyId）。`,
    result.data
  )
}

export async function listPanesTool(ownerPtyId?: string): Promise<ToolResult> {
  const result = await callBridge({ type: 'list' }, ownerPtyId)
  if (!result.ok) return fail(result.error || '列出窗格失败')
  return ok('当前窗格列表。窗格的唯一标识就是 ptyId——想在指定窗格执行命令时给 pane_id 字段传该窗格的 ptyId 即可。', result.data)
}
