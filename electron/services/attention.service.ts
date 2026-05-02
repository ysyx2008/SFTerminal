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
   * 绑定主窗口。窗口重建时可重复调用——focus 监听器只挂在传入的 BrowserWindow 实例上，
   * 旧窗口对象会随 GC 回收，不会出现重复触发。
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
    win.on('focus', () => this.clear())
  }

  /**
   * 提请用户关注。窗口已聚焦时不做任何事——用户已经在看了。
   */
  request(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isFocused()) return

    this.active = true

    try {
      if (process.platform === 'darwin') {
        // 用圆点而非数字：我们不计数，只表达"有事情结束了"
        app.dock?.setBadge('•')
      } else if (process.platform === 'win32') {
        win.flashFrame(true)
      } else {
        // Linux：部分桌面环境（Unity 等）支持 setBadgeCount，其它环境是 no-op
        app.setBadgeCount(1)
      }
    } catch (e) {
      log.debug('AttentionService.request failed:', e)
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
      log.debug('AttentionService.clear failed:', e)
    }
  }
}

export const attentionService = new AttentionService()
