/**
 * SSH 窗格原地重连（ensure_connected / 用时懒重连共用）
 *
 * - 经 split-pane bridge `reconnect` → 前端 reconnectSsh（reuseId + remapPtyId）
 * - 按 ptyId 去重：并发工具共享同一 Promise
 * - 成功只扶管子，不重跑业务命令；调用方负责把可见结果交给模型
 */
import { splitPaneBridge } from '../../split-pane-bridge.service'
import { t } from '../i18n'
import type { ToolExecutorConfig, ToolResult } from './types'
import { paneGoneResult } from './utils'

export interface PaneReconnectOk {
  ok: true
  ptyId: string
  /** true = 本次确实发起了重连；false = 本来就通，幂等成功 */
  didReconnect: boolean
  freshSession: boolean
}

export interface PaneReconnectFail {
  ok: false
  ptyId: string
  reason: 'not_ssh' | 'needs_session' | 'bridge' | 'pane_gone' | 'unknown'
  error: string
  needsSession?: boolean
}

export type PaneReconnectOutcome = PaneReconnectOk | PaneReconnectFail

const inFlightByPtyId = new Map<string, Promise<PaneReconnectOutcome>>()

function ownerKey(executor?: ToolExecutorConfig): string | undefined {
  return executor?.agentId || executor?.getCurrentPtyId?.()
}

/**
 * 确保 SSH 窗格连通。
 * @param skipIfConnected 若已 hasInstance，则幂等成功且不重连（ensure_connected 行为）
 */
export async function ensurePaneConnected(
  ptyId: string,
  executor: ToolExecutorConfig | undefined,
  options?: { skipIfConnected?: boolean }
): Promise<PaneReconnectOutcome> {
  const skipIfConnected = options?.skipIfConnected !== false

  if (executor?.terminalService?.hasInstance(ptyId) && skipIfConnected) {
    return {
      ok: true,
      ptyId,
      didReconnect: false,
      freshSession: false
    }
  }

  const existing = inFlightByPtyId.get(ptyId)
  if (existing) return existing

  const run = doReconnect(ptyId, executor)
  inFlightByPtyId.set(ptyId, run)
  try {
    return await run
  } finally {
    inFlightByPtyId.delete(ptyId)
  }
}

async function doReconnect(
  ptyId: string,
  executor: ToolExecutorConfig | undefined
): Promise<PaneReconnectOutcome> {
  const result = await splitPaneBridge.exec({ type: 'reconnect', ptyId }, ownerKey(executor))
  if (!result.ok) {
    const data = result.data as { needsSession?: boolean } | undefined
    if (data?.needsSession) {
      return {
        ok: false,
        ptyId,
        reason: 'needs_session',
        needsSession: true,
        error: result.error || t('error.ssh_reconnect_needs_session')
      }
    }
    return {
      ok: false,
      ptyId,
      reason: 'bridge',
      error: result.error || t('error.ssh_reconnect_failed')
    }
  }

  return {
    ok: true,
    ptyId,
    didReconnect: true,
    freshSession: true
  }
}

/** ensure_connected 工具成功/失败文案 */
export function ensureConnectedToolResult(outcome: PaneReconnectOutcome): ToolResult {
  if (outcome.ok) {
    if (!outcome.didReconnect) {
      return {
        success: true,
        output: t('pane.ensure_already_connected', { paneId: outcome.ptyId })
      }
    }
    return {
      success: true,
      output: t('pane.ensure_reconnected_fresh', { paneId: outcome.ptyId })
    }
  }
  return {
    success: false,
    output: '',
    error: outcome.error,
    briefError: outcome.error
  }
}

interface ListedPane {
  ptyId: string
  terminalType?: string
}

/**
 * 命令/写入因断线失败后：若窗格仍在 layout 且为 SSH，尝试懒重连一次。
 * **不**重跑原命令。窗格已关则走 paneGoneResult。
 */
export async function lazyReconnectAfterDisconnect(
  ptyId: string,
  executor: ToolExecutorConfig | undefined
): Promise<ToolResult> {
  const listed = await splitPaneBridge.exec({ type: 'list' }, ownerKey(executor))
  const panes = (listed.ok ? (listed.data as { panes?: ListedPane[] } | undefined)?.panes : undefined) || []
  const pane = panes.find(p => p.ptyId === ptyId)

  if (!pane) {
    // 窗格已从 layout 消失（用户关掉）——不是「可重连断线」
    return paneGoneResult(ptyId, executor)
  }

  if (pane.terminalType === 'local') {
    return paneGoneResult(ptyId, executor)
  }

  const outcome = await ensurePaneConnected(ptyId, executor, { skipIfConnected: false })
  if (outcome.ok && outcome.didReconnect) {
    const msg = t('pane.lazy_reconnected_fresh', { paneId: outcome.ptyId })
    return {
      success: false,
      output: '',
      error: msg,
      briefError: t('pane.lazy_reconnected_brief')
    }
  }
  if (outcome.ok && !outcome.didReconnect) {
    const msg = t('pane.disconnect_op_not_delivered', { paneId: outcome.ptyId })
    return {
      success: false,
      output: '',
      error: msg,
      briefError: msg
    }
  }

  const detail = outcome.ok ? '' : outcome.error
  return {
    success: false,
    output: '',
    error: t('pane.lazy_reconnect_failed', { paneId: ptyId, detail }),
    briefError: t('error.ssh_reconnect_failed')
  }
}
