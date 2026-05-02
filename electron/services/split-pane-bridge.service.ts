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
 * - 工具元数据 supportedModes 限定为 ['local', 'ssh']
 * - 5s 操作超时，避免卡死 Agent 流程
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

// close / focus 的 ptyId 字段=目标窗格的 ptyId（窗格的唯一稳定标识）。
// 历史曾用 paneId 字段名，已统一为 ptyId 以避免与"布局节点 id"概念混淆。
export type SplitPaneOp =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; target?: SplitTargetOp }
  | { type: 'close'; ptyId: string }
  | { type: 'focus'; ptyId: string }
  | { type: 'list' }

export interface SplitPaneResult {
  ok: boolean
  data?: unknown
  error?: string
}

const OP_TIMEOUT_MS = 5000

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
   * @param ownerPtyId  发起调用的 Agent 自己的初始 ptyId。handler 用它反查到 Agent
   *                    所在的 tab，再操作那个 tab——而不是用户当前看的 activeTab。
   *                    避免"用户切到别的 tab 时 Agent 误操作别人的 tab"。
   *                    缺省（如 UI 用户操作触发）时 handler 退回到 activeTab。
   */
  async exec(op: SplitPaneOp, ownerPtyId?: string): Promise<SplitPaneResult> {
    const w = this.window
    if (!w || w.isDestroyed()) {
      log.warn(`exec ${op.type}: window not available`)
      return { ok: false, error: 'split-pane bridge: renderer window not available (likely a non-UI agent context)' }
    }

    return new Promise<SplitPaneResult>((resolve) => {
      const id = uuid()
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          log.warn(`split-pane op ${op.type} timed out (id=${id}, waited=${Date.now() - startedAt}ms)`)
          resolve({ ok: false, error: 'split-pane operation timed out' })
        }
      }, OP_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (r) => {
          log.info(`exec ${op.type} resolved (id=${id}, elapsed=${Date.now() - startedAt}ms, ok=${r.ok})`)
          resolve(r)
        },
        timer
      })

      try {
        log.info(`exec ${op.type} send (id=${id}) ownerPtyId=${ownerPtyId || 'none'}`)
        w.webContents.send('split-pane:exec', { id, op, ownerPtyId })
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
