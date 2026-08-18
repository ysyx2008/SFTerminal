/**
 * 分屏反向 IPC 桥接
 *
 * Agent 工具运行在主进程，但分屏布局活在前端 Pinia store 里。
 * 此 bridge 提供"主进程 → 渲染进程"的反向 IPC 通道：
 *
 *   主进程 (Agent 工具) -- exec(op) --> webContents.send('split-pane:exec', { id, op })
 *                                                      ↓
 *                                          渲染进程 store 监听并执行
 *                                                      ↓
 *   主进程 <-- ipcMain.on('split-pane:result', { id, result })
 *
 * 设计要点：
 * - 仅在终端 Agent（有对应 BrowserWindow）下可用，Watch / IM 远程 Agent 调用会超时返回错误
 * - 桌面助手也可 open 真终端；Watch / IM / CLI 无渲染窗时仍会失败
 * - 默认 5s 超时；reconnect 握手更久，单独放宽
 */
import { BrowserWindow, ipcMain } from 'electron'
import { v4 as uuid } from 'uuid'
import { createLogger } from '../utils/logger'

const log = createLogger('SplitPaneBridge')

/** Agent 分屏时新窗格的目标连接源（与渲染端 SplitTarget 字段对齐，跨 IPC 序列化用纯对象形态） */
export type SplitTargetOp =
  | { kind: 'inherit' }
  | { kind: 'local' }
  | { kind: 'ssh', sessionId: string }

// close / focus / reconnect 的 ptyId 字段=目标窗格的 ptyId（窗格的唯一稳定标识）。
// 历史曾用 paneId 字段名，已统一为 ptyId 以避免与"布局节点 id"概念混淆。
export type SplitPaneOp =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; target?: SplitTargetOp }
  | { type: 'open'; target?: SplitTargetOp }
  | { type: 'close'; ptyId: string }
  | { type: 'focus'; ptyId: string }
  | { type: 'list' }
  | { type: 'reconnect'; ptyId?: string }

export interface SplitPaneResult {
  ok: boolean
  data?: unknown
  error?: string
}

const DEFAULT_OP_TIMEOUT_MS = 5000
/** SSH 握手可能远超默认超时；reconnect 单独放宽 */
const RECONNECT_OP_TIMEOUT_MS = 45000

function timeoutForOp(op: SplitPaneOp): number {
  return op.type === 'reconnect' ? RECONNECT_OP_TIMEOUT_MS : DEFAULT_OP_TIMEOUT_MS
}

class SplitPaneBridge {
  private window: BrowserWindow | null = null
  private pending = new Map<string, { resolve: (r: SplitPaneResult) => void; timer: NodeJS.Timeout }>()
  private ipcListenerInstalled = false

  init(window: BrowserWindow): void {
    this.window = window

    if (this.ipcListenerInstalled) return
    this.ipcListenerInstalled = true

    ipcMain.on('split-pane:result', (_event, payload: { id: string; result: SplitPaneResult }) => {
      if (!payload || typeof payload.id !== 'string' || !payload.result) return
      const handler = this.pending.get(payload.id)
      if (!handler) return
      this.pending.delete(payload.id)
      clearTimeout(handler.timer)
      handler.resolve(payload.result)
    })
  }

  /** 重新绑定窗口（窗口销毁后重建时使用） */
  attachWindow(window: BrowserWindow): void {
    this.window = window
  }

  detachWindow(): void {
    this.window = null
  }

  /**
   * 执行分屏 op
   *
   * @param ownerAgentKey  发起调用的 Agent 的稳定 key（终端 = tabId）。handler 用它
   *                       反查到 Agent 所在的 tab，再操作那个 tab——而不是用户当前
   *                       看的 activeTab。避免「用户切到别的 tab 时 Agent 误操作别人的
   *                       tab」，以及「重连换 pane ptyId 后找不到 tab」。
   *                       兼容历史：传入 pane ptyId 时 findTabIdByPtyId 仍可命中。
   *                       缺省（如 UI 用户操作触发）时 handler 退回到 activeTab。
   */
  async exec(op: SplitPaneOp, ownerAgentKey?: string): Promise<SplitPaneResult> {
    const w = this.window
    if (!w || w.isDestroyed()) {
      log.warn(`exec ${op.type}: window not available`)
      return { ok: false, error: 'split-pane bridge: renderer window not available (likely a non-UI agent context)' }
    }

    const opTimeout = timeoutForOp(op)
    return new Promise<SplitPaneResult>((resolve) => {
      const id = uuid()
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          log.warn(`split-pane op ${op.type} timed out (id=${id}, waited=${Date.now() - startedAt}ms)`)
          resolve({ ok: false, error: 'split-pane operation timed out' })
        }
      }, opTimeout)
      this.pending.set(id, {
        resolve: (r) => {
          log.info(`exec ${op.type} resolved (id=${id}, elapsed=${Date.now() - startedAt}ms, ok=${r.ok})`)
          resolve(r)
        },
        timer
      })

      try {
        log.info(`exec ${op.type} send (id=${id}) ownerAgentKey=${ownerAgentKey || 'none'}`)
        w.webContents.send('split-pane:exec', { id, op, ownerAgentKey })
      } catch (e) {
        if (this.pending.delete(id)) {
          clearTimeout(timer)
          log.warn(`exec ${op.type} send threw (id=${id}):`, e)
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    })
  }
}

export const splitPaneBridge = new SplitPaneBridge()
