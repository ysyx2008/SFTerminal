/**
 * SSO 授权回调窗（应用内 BrowserWindow + will-redirect）
 * 模式对齐 skills/email/oauth.ts，仅截获 redirectUri 上的 code/state。
 */
import { BrowserWindow, session } from 'electron'
import { createLogger } from '../../utils/logger'

const log = createLogger('AuthLoginWindow')

export interface LoginWindowResult {
  code: string
  state: string
}

/**
 * 打开授权页，等到 redirectUri 带上 code（或 error）后关闭并返回。
 */
export function openSsoLoginWindow(
  authorizationUrl: string,
  redirectUri: string
): Promise<LoginWindowResult> {
  let redirectOrigin: string
  let redirectPath: string
  try {
    const u = new URL(redirectUri)
    redirectOrigin = u.origin
    redirectPath = u.pathname
  } catch {
    return Promise.reject(new Error(`Invalid redirectUri: ${redirectUri}`))
  }

  const authWindow = new BrowserWindow({
    width: 600,
    height: 740,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 与主窗口 cookie 隔离，避免串站
      session: session.fromPartition('persist:sso-login'),
    },
  })

  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const tryHandleCallback = (url: string, event?: { preventDefault: () => void }) => {
      let urlObj: URL
      try {
        urlObj = new URL(url)
      } catch {
        return
      }
      if (urlObj.origin !== redirectOrigin || urlObj.pathname !== redirectPath) {
        return
      }
      event?.preventDefault()
      const error = urlObj.searchParams.get('error')
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')
      try {
        if (!authWindow.isDestroyed()) authWindow.close()
      } catch { /* ignore */ }

      if (error) {
        finish(() => reject(new Error(`SSO authorization failed: ${error}`)))
        return
      }
      if (!code || !state) {
        finish(() => reject(new Error('SSO callback missing code or state')))
        return
      }
      finish(() => resolve({ code, state }))
    }

    authWindow.webContents.on('will-redirect', (event, url) => {
      tryHandleCallback(url, event)
    })
    authWindow.webContents.on('will-navigate', (event, url) => {
      tryHandleCallback(url, event)
    })

    authWindow.on('closed', () => {
      finish(() => reject(new Error('SSO login cancelled')))
    })

    log.info('Opening SSO login window')
    void authWindow.loadURL(authorizationUrl).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
}
