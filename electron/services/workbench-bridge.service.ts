/**
 * 工作台反向 IPC 桥接
 *
 * Agent 工具运行在主进程，工作台 UI 状态（产出物面板等）在渲染进程 Pinia store。
 * 模式同 split-pane-bridge：主进程 exec → 渲染进程 handler → result 回传。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { v4 as uuid } from 'uuid'
import { createLogger } from '../utils/logger'

const log = createLogger('WorkbenchBridge')

export type WorkbenchOp = { type: 'list_artifacts' }

export interface WorkbenchBridgeResult {
  ok: boolean
  data?: unknown
  error?: string
}

const OP_TIMEOUT_MS = 5000

class WorkbenchBridge {
  private window: BrowserWindow | null = null
  private pending = new Map<string, { resolve: (r: WorkbenchBridgeResult) => void; timer: NodeJS.Timeout }>()
  private ipcListenerInstalled = false

  init(window: BrowserWindow): void {
    this.window = window

    if (this.ipcListenerInstalled) return
    this.ipcListenerInstalled = true

    ipcMain.on('workbench:result', (_event, payload: { id: string; result: WorkbenchBridgeResult }) => {
      if (!payload || typeof payload.id !== 'string' || !payload.result) return
      const handler = this.pending.get(payload.id)
      if (!handler) return
      this.pending.delete(payload.id)
      clearTimeout(handler.timer)
      handler.resolve(payload.result)
    })
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window
  }

  detachWindow(): void {
    this.window = null
  }

  /**
   * @param ownerAgentKey Agent 实例 key（独立助手 = tab.agentId；终端 = tabId / ptyId）
   */
  async exec(op: WorkbenchOp, ownerAgentKey?: string): Promise<WorkbenchBridgeResult> {
    const w = this.window
    if (!w || w.isDestroyed()) {
      log.warn(`exec ${op.type}: window not available`)
      return { ok: false, error: 'workbench bridge: renderer window not available' }
    }

    return new Promise<WorkbenchBridgeResult>((resolve) => {
      const id = uuid()
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          log.warn(`workbench op ${op.type} timed out (id=${id}, waited=${Date.now() - startedAt}ms)`)
          resolve({ ok: false, error: 'workbench operation timed out' })
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
        log.info(`exec ${op.type} send (id=${id}) ownerAgentKey=${ownerAgentKey || 'none'}`)
        w.webContents.send('workbench:exec', { id, op, ownerAgentKey })
      } catch (e) {
        if (this.pending.delete(id)) {
          clearTimeout(timer)
          resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    })
  }
}

export const workbenchBridge = new WorkbenchBridge()
