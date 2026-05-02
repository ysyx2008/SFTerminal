/**
 * 分屏反向 IPC 处理器（渲染进程侧）
 *
 * 监听主进程 Agent 工具发起的分屏操作请求，调用 terminalStore 中相应方法，
 * 把执行结果回报给主进程 bridge。
 *
 * Tab 解析：bridge 透传 ownerPtyId（Agent 自己的初始 ptyId）时，handler 用它
 * 反查 Agent 所在的 tab 再操作；缺省时（如 UI 用户操作）退回到 activeTab。
 * 这样避免"用户切到别的 tab 时 Agent 误改别人 tab"的问题。
 */
import { useTerminalStore, type SplitPane, type SplitTarget, type TerminalTab } from '../stores/terminal'
import { createLogger } from '../utils/logger'

const log = createLogger('SplitPaneHandler')

type Op =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; target?: SplitTarget }
  | { type: 'close'; paneId: string }
  | { type: 'focus'; paneId: string }
  | { type: 'list' }

let unsubscribe: (() => void) | null = null

export function initSplitPaneHandler(): void {
  if (unsubscribe) return
  if (!window.electronAPI?.splitPane?.onExec) {
    log.warn('electronAPI.splitPane unavailable, skip init')
    return
  }

  log.info('split-pane handler initialized')
  unsubscribe = window.electronAPI.splitPane.onExec(async (id, op, ownerPtyId) => {
    log.info(`recv op id=${id} type=${op.type} ownerPtyId=${ownerPtyId || 'none'}`)
    let result: { ok: boolean; data?: unknown; error?: string }
    try {
      // 每次都重新拿最新 store 实例，避免 HMR 后闭包持有旧 store
      const store = useTerminalStore()
      // dispatch 整体加超时——任何路径下都要保证 sendResult 一定回到主进程，
      // 否则主进程 bridge 即使有自己的 timeout，工具调用层观察到的也是"无限挂起"。
      result = await Promise.race([
        dispatch(store, op as Op, ownerPtyId),
        new Promise<{ ok: boolean; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('split-pane handler dispatch timeout')), 8000)
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
  ownerPtyId?: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  // 解析操作目标 tab：
  // - ownerPtyId 提供（Agent 调用）：用 Agent 所在的 tab，避免跟随 activeTab 跑到用户切去的别人 tab
  // - 缺省（UI 用户操作）：用当前 activeTab，与历史行为一致
  let tab: TerminalTab | undefined
  if (ownerPtyId) {
    const tabId = store.findTabIdByPtyId(ownerPtyId)
    if (tabId) {
      tab = store.tabs.find(t => t.id === tabId)
    }
    if (!tab) {
      log.warn(`dispatch ${op.type}: no tab owns ptyId=${ownerPtyId}`)
      return { ok: false, error: `No tab found for ptyId=${ownerPtyId} (terminal may have been closed)` }
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
      log.info(`close start paneId=${op.paneId}`)
      // 防自毁：Agent 关掉最后一个 pane 等于关闭整个 tab，Agent 实例随 PTY 销毁
      // 而被回收，IPC 回信丢失导致工具调用超时——而且关掉的就是 Agent 自己的执行
      // 环境。此路径仅允许用户手动操作（点击窗格 X 按钮，走 SplitPaneView 直连 store.closePane）。
      const allPanes = tab.splitLayout ? collectPanes(tab.splitLayout) : []
      if (allPanes.length <= 1) {
        return {
          ok: false,
          error: '只剩最后一个窗格，不能通过 close_pane 关闭——这会关掉整个 tab、终止当前 Agent 会话。如需关闭 tab，请让用户手动操作。'
        }
      }

      // 防自残：Agent 不能关掉自己所在的窗格——会让 Agent PTY 一起被销毁，
      // Agent 实例死亡、本次工具调用永远拿不到 result，前端表现为"卡死"。
      // 入参 paneId 可能是布局节点 id 或 ptyId，两种都得查。
      if (ownerPtyId) {
        const targetPane = allPanes.find(p => p.paneId === op.paneId || p.ptyId === op.paneId)
        if (targetPane && targetPane.ptyId === ownerPtyId) {
          return {
            ok: false,
            error: `不能关闭你自己所在的窗格（ptyId=${ownerPtyId}）——这会终止你自己的执行环境。要清理这个窗格，请让用户手动点窗格右上角的 ✕。如果想让其他窗格"换内容"，应该关那个其他窗格再 split_terminal，而不是关自己。`
          }
        }
      }
      const removed = await store.closePane(tab.id, op.paneId)
      log.info(`close done paneId=${op.paneId} removed=${removed}`)
      if (!removed) {
        return {
          ok: false,
          error: `Pane not found: "${op.paneId}". Use list_panes to get current pane_id (布局可能在上次操作后已经变化).`
        }
      }
      const remainingPanes = collectPanes(tab.splitLayout)
      return {
        ok: true,
        data: {
          tabId: tab.id,
          closedPaneId: op.paneId,
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
      const ok = store.setActivePaneInTab(tab.id, op.paneId)
      if (!ok) {
        return {
          ok: false,
          error: `Pane not found: "${op.paneId}". Use list_panes to get current pane_id.`
        }
      }
      return {
        ok: true,
        data: { tabId: tab.id, activePaneId: op.paneId }
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
                paneId: 'main',
                ptyId: tab.ptyId,
                label: 'Main',
                isActive: true,
                terminalType: tab.type as 'local' | 'ssh'
              }]
            : []
        }
      }
    }
    default:
      return { ok: false, error: `Unknown split-pane op` }
  }
}

function collectPanes(
  layout: SplitPane | undefined
): Array<{ paneId: string; ptyId: string; label: string; isActive: boolean; terminalType: string }> {
  if (!layout) return []
  const out: Array<{ paneId: string; ptyId: string; label: string; isActive: boolean; terminalType: string }> = []
  const walk = (node: SplitPane) => {
    if (node.type === 'terminal') {
      if (!node.ptyId) return
      out.push({
        paneId: node.id,
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

