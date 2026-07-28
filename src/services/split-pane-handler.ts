/**
 * 分屏反向 IPC 处理器（渲染进程侧）
 *
 * 监听主进程 Agent 工具发起的分屏操作请求，调用 terminalStore 中相应方法，
 * 把执行结果回报给主进程 bridge。
 *
 * Tab 解析：bridge 透传 ownerAgentKey（终端 Agent = tabId，稳定）时，handler
 * 用它反查 Agent 所在的 tab 再操作；缺省时（如 UI 用户操作）退回到 activeTab。
 * 兼容历史：若传入的是 pane ptyId，findTabIdByPtyId 仍能命中。
 * 这样避免「用户切到别的 tab 时 Agent 误改别人 tab」以及「重连换 ptyId 后
 * list_panes 找不到 tab」。
 */
import { useTerminalStore, type SplitPane, type SplitTarget, type TerminalTab } from '../stores/terminal'
import { createLogger } from '../utils/logger'

const log = createLogger('SplitPaneHandler')

type Op =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; target?: SplitTarget }
  | { type: 'close'; ptyId: string }
  | { type: 'focus'; ptyId: string }
  | { type: 'list' }
  | { type: 'reconnect'; ptyId?: string }

let unsubscribe: (() => void) | null = null

const DEFAULT_HANDLER_TIMEOUT_MS = 8000
const RECONNECT_HANDLER_TIMEOUT_MS = 50000

function handlerTimeoutMs(op: Op): number {
  return op.type === 'reconnect' ? RECONNECT_HANDLER_TIMEOUT_MS : DEFAULT_HANDLER_TIMEOUT_MS
}

export function initSplitPaneHandler(): void {
  if (unsubscribe) return
  if (!window.electronAPI?.splitPane?.onExec) {
    log.warn('electronAPI.splitPane unavailable, skip init')
    return
  }

  log.info('split-pane handler initialized')
  unsubscribe = window.electronAPI.splitPane.onExec(async (id, op, ownerAgentKey) => {
    log.info(`recv op id=${id} type=${op.type} ownerAgentKey=${ownerAgentKey || 'none'}`)
    let result: { ok: boolean; data?: unknown; error?: string }
    try {
      // 每次都重新拿最新 store 实例，避免 HMR 后闭包持有旧 store
      const store = useTerminalStore()
      // dispatch 整体加超时——任何路径下都要保证 sendResult 一定回到主进程，
      // 否则主进程 bridge 即使有自己的 timeout，工具调用层观察到的也是"无限挂起"。
      const timeoutMs = handlerTimeoutMs(op as Op)
      result = await Promise.race([
        dispatch(store, op as Op, ownerAgentKey),
        new Promise<{ ok: boolean; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('split-pane handler dispatch timeout')), timeoutMs)
        )
      ])
      log.info(`dispatch done id=${id} ok=${result.ok} err=${result.error || ''}`)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
      log.warn(`dispatch threw id=${id}`, e)
    }
    try {
      window.electronAPI.splitPane.sendResult(id, result)
      log.info(`sendResult id=${id}`)
    } catch (e) {
      log.error(`sendResult failed id=${id}`, e)
    }
  })
}

// Vite HMR：模块热替换时清理旧 listener，避免重复注册
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    log.info('HMR dispose split-pane handler')
    disposeSplitPaneHandler()
  })
}

export function disposeSplitPaneHandler(): void {
  unsubscribe?.()
  unsubscribe = null
}

async function dispatch(
  store: ReturnType<typeof useTerminalStore>,
  op: Op,
  ownerAgentKey?: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // 解析操作目标 tab：
  // - ownerAgentKey 提供（Agent 调用）：优先 tab.id / agentId（稳定），再兜底按 pane ptyId 查
  // - 缺省（UI 用户操作）：用当前 activeTab，与历史行为一致
  let tab: TerminalTab | undefined
  if (ownerAgentKey) {
    const tabId =
      store.findTabIdByPtyId(ownerAgentKey) // 含 tab.id === key（终端 agentKey）
      ?? store.findTabIdByAgentId(ownerAgentKey)
    if (tabId) {
      tab = store.tabs.find(t => t.id === tabId)
    }
    if (!tab) {
      log.warn(`dispatch ${op.type}: no tab owns agentKey/ptyId=${ownerAgentKey}`)
      return {
        ok: false,
        error: `No tab found for agentKey=${ownerAgentKey} (terminal may have been closed; if you recently reconnected, retry list_panes)`
      }
    }
  } else {
    tab = store.activeTab
    if (!tab) {
      log.warn(`dispatch ${op.type}: no active tab`)
      return { ok: false, error: 'No active tab' }
    }
  }

  if (tab.type === 'assistant') {
    log.warn(`dispatch ${op.type}: tab is assistant`)
    return { ok: false, error: 'Cannot operate split panes on assistant tab' }
  }
  log.info(`dispatch ${op.type} tab=${tab.id} type=${tab.type}`)

  // 锁定到 tab.id 后续操作都用它，避免下面任何路径里再读到 activeTab 引发漂移
  const tabId = tab.id

  switch (op.type) {
    case 'split': {
      const t0 = Date.now()
      log.info(`split start direction=${op.direction} target=${op.target?.kind || 'inherit'}`)
      const newPaneId = await store.splitTerminal(op.direction, op.target, tabId)
      const t1 = Date.now()
      log.info(`split done newPaneId=${newPaneId || 'null'} elapsed=${t1 - t0}ms`)
      if (!newPaneId) {
        const reason = store.getLastSplitError() || 'no active tab, terminal creation failed, or invalid SSH sessionId'
        return { ok: false, error: `Split failed: ${reason}` }
      }
      return {
        ok: true,
        data: {
          tabId: tab.id,
          newPaneId,
          panes: collectPanes(tab.splitLayout)
        }
      }
    }
    case 'close': {
      log.info(`close start ptyId=${op.ptyId}`)
      // 不允许 Agent 通过 close_pane 关掉最后一个窗格——这等于关闭整个 tab。
      // tab 的关闭是用户决策，应通过 UI 完成。
      const allPanes = tab.splitLayout ? collectPanes(tab.splitLayout) : []
      if (allPanes.length <= 1) {
        return {
          ok: false,
          error: '只剩最后一个窗格，不能通过 close_pane 关闭——这等于关闭整个 tab。如需关闭 tab，请让用户手动操作。'
        }
      }

      // Agent 关自己当前窗格是允许的：架构上 Agent 实例与 PTY 解耦不会自残；
      // 关闭后由工具侧根据返回的 panes.isActive 把 run.ptyId 切到新激活窗格。
      // store.closePane 第 2 参数命名为 paneId 是历史接口，实际按 ptyId 兜底查找。
      const removed = await store.closePane(tab.id, op.ptyId)
      log.info(`close done ptyId=${op.ptyId} removed=${removed}`)
      if (!removed) {
        return {
          ok: false,
          error: `Pane not found: "${op.ptyId}". No pane has this ptyId — use list_panes to refresh current ptyIds.`
        }
      }
      const remainingPanes = collectPanes(tab.splitLayout)
      return {
        ok: true,
        data: {
          tabId: tab.id,
          closedPtyId: op.ptyId,
          panes: remainingPanes,
          // mode 按叶子数量判断而非 splitLayout 是否存在——root 永远是 split 容器，
          // 但只剩 1 个叶子时用户体验等同单屏，应该报 'single' 让 Agent 心智一致。
          mode: remainingPanes.length > 1 ? 'split' : 'single'
        }
      }
    }
    case 'focus': {
      if (!tab.splitLayout) {
        return { ok: false, error: 'Tab is not in split mode' }
      }
      const ok = store.setActivePaneInTab(tab.id, op.ptyId)
      if (!ok) {
        return {
          ok: false,
          error: `Pane not found: "${op.ptyId}". No pane has this ptyId — use list_panes to refresh current ptyIds.`
        }
      }
      return {
        ok: true,
        data: { tabId: tab.id, activePtyId: op.ptyId }
      }
    }
    case 'list': {
      if (tab.splitLayout) {
        const panes = collectPanes(tab.splitLayout)
        // mode 按叶子数量判断：root 永远是 split 容器（ensureRootSplitLayoutForTab 设计），
        // 但只有 1 个 terminal 叶子时用户体验等同单屏，应报 'single'。
        return {
          ok: true,
          data: {
            tabId: tab.id,
            mode: panes.length > 1 ? ('split' as const) : ('single' as const),
            panes
          }
        }
      }
      return {
        ok: true,
        data: {
          tabId: tab.id,
          mode: 'single' as const,
          panes: tab.ptyId
            ? [{
                ptyId: tab.ptyId,
                label: 'Main',
                isActive: true,
                terminalType: tab.type as 'local' | 'ssh'
              }]
            : []
        }
      }
    }
    case 'reconnect': {
      const targetPtyId = op.ptyId || tab.ptyId
      if (!targetPtyId) {
        return { ok: false, error: 'reconnect requires ptyId (no default pane)' }
      }
      log.info(`reconnect start ptyId=${targetPtyId}`)
      try {
        const result = await store.reconnectSsh(tabId, targetPtyId)
        if (result.needsSession) {
          return {
            ok: false,
            error: result.error || 'Cannot reconnect: SSH session was not saved. Ask the user to reconnect from the UI or save the session.',
            data: { needsSession: true, ptyId: targetPtyId }
          }
        }
        if (!result.success) {
          return {
            ok: false,
            error: result.error || 'SSH reconnect failed',
            data: { ptyId: targetPtyId }
          }
        }
        return {
          ok: true,
          data: {
            tabId,
            ptyId: targetPtyId,
            reconnected: true,
            freshSession: true
          }
        }
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          data: { ptyId: targetPtyId }
        }
      }
    }
    default:
      return { ok: false, error: `Unknown split-pane op` }
  }
}

/**
 * 给 Agent 工具看的 pane 列表。
 *
 * 只暴露 ptyId 一种标识——同一窗格会话实例 id（SSH 重连 reuseId 保持不变）。
 * 不返回布局节点 id（"paneId"），因为它会在布局压缩（lift）后被替换，旧值失效，
 * Agent 拿着旧 paneId 调 close_pane / focus_pane 会报 not found。
 *
 * 内部仍保留布局节点 id（用于 Vue :key、树遍历主键、split 容器标识），但对外
 * 只承诺 ptyId 这一种引用方式，避免 Agent 在两个等价名字之间踩坑。
 */
function collectPanes(
  layout: SplitPane | undefined
): Array<{ ptyId: string; label: string; isActive: boolean; terminalType: string }> {
  if (!layout) return []
  const out: Array<{ ptyId: string; label: string; isActive: boolean; terminalType: string }> = []
  const walk = (node: SplitPane) => {
    if (node.type === 'terminal') {
      if (!node.ptyId) return
      out.push({
        ptyId: node.ptyId,
        label: node.label || '',
        isActive: Boolean(node.isActive),
        terminalType: node.terminalType || 'local'
      })
      return
    }
    for (const c of node.children || []) walk(c)
  }
  walk(layout)
  return out
}

