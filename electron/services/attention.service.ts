import { app, type BrowserWindow } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('attention')

/**
 * AttentionService — 提请用户关注
 *
 * 用途：当某些"用户应该看一眼"的事件（例如 Agent 任务结束）发生，
 * 而主窗口不在前台焦点时，通过任务栏 / Dock 上的视觉提示提醒用户。
 *
 * 跨平台策略：
 * - macOS  : Dock badge 圆点
 * - Windows: 任务栏图标闪烁 (flashFrame)
 * - Linux  : setBadgeCount(1)（仅在支持的桌面环境生效，如 Unity）
 *
 * 主窗口聚焦后会自动清除提示。
 */
class AttentionService {
  private mainWindow: BrowserWindow | null = null
  private active = false
  /**
   * 自维护的窗口聚焦状态——不依赖每次 win.isFocused() 的实时返回。
   *
   * 经验：生产模式下用户 Cmd+Tab 切走后，Agent 完成回调触发的瞬间，
   * win.isFocused() 与 focus/blur 事件看到的状态偶有不一致（疑似
   * Electron 焦点状态与 IPC 调度间的时序差），改成事件驱动更稳。
   */
  private focused = true

  /**
   * 绑定主窗口。窗口重建时可重复调用——focus/blur 监听器只挂在传入的
   * BrowserWindow 实例上，旧窗口对象会随 GC 回收，不会出现重复触发。
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
    this.focused = win.isFocused()
    win.on('focus', () => {
      this.focused = true
      this.clear()
    })
    win.on('blur', () => {
      this.focused = false
    })
  }

  /**
   * 提请用户关注。窗口当前聚焦则不做任何事——用户已经在看了。
   */
  request(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) {
      log.debug('attention.request skipped: no window')
      return
    }
    if (this.focused) {
      log.debug('attention.request skipped: window focused')
      return
    }

    this.active = true

    try {
      if (process.platform === 'darwin') {
        // 防御：用户按 Cmd+W 关到托盘时主进程会调 app.dock.hide()，
        // Dock 图标整个消失，setBadge 没视觉效果——重新 show 一下让
        // 图标带着角标出现。Cmd+Tab 走的常规后台场景 dock 一直可见，
        // 这段是 no-op。
        if (app.dock && !app.dock.isVisible()) {
          app.dock.show().catch(() => {})
        }
        // 圆点而非数字：我们不计数，只表达"有事情结束了"
        app.dock?.setBadge('•')
        log.info('attention badge set (macOS dock)')
      } else if (process.platform === 'win32') {
        win.flashFrame(true)
        log.info('attention flash started (Windows)')
      } else {
        // Linux：部分桌面环境（Unity 等）支持 setBadgeCount，其它环境是 no-op
        app.setBadgeCount(1)
        log.info('attention badge set (Linux)')
      }
    } catch (e) {
      log.warn('attention.request failed:', e)
    }
  }

  /**
   * 清除提示（窗口聚焦时自动调用，外部一般无需直接调）。
   */
  clear(): void {
    if (!this.active) return
    this.active = false

    const win = this.mainWindow
    try {
      if (process.platform === 'darwin') {
        app.dock?.setBadge('')
      } else if (process.platform === 'win32') {
        if (win && !win.isDestroyed()) win.flashFrame(false)
      } else {
        app.setBadgeCount(0)
      }
    } catch (e) {
      log.debug('attention.clear failed:', e)
    }
  }
}

export const attentionService = new AttentionService()
