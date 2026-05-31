import { useI18n } from 'vue-i18n'
import { showConfirm } from './useConfirm'
import { toast } from './useToast'
import { createLogger } from '../utils/logger'
import type { LocaleType } from '../i18n'
import { getDownloadPageUrl } from '../config/urls'

const log = createLogger('AppUpdater')

/**
 * 全局更新提醒
 * - 发现新版本：弹窗（macOS 手动下载）；Win/Linux 仅在未开启自动下载时 Toast 提示
 * - 下载完成：确认弹窗 —「立即安装」或「退出时安装」/「稍后提醒」
 */
export function useAppUpdaterPrompts() {
  const { t, locale } = useI18n()
  const isMac = /Mac/i.test(navigator.platform)
  const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

  let cleanup: (() => void) | null = null
  let lastAvailableToastVersion = ''
  let lastMacAvailablePromptVersion = ''
  let installPromptOpen = false

  async function isInstallOnQuitEnabled(): Promise<boolean> {
    const value = await window.electronAPI.config.get('installUpdateOnQuit') as boolean | undefined
    return value !== false
  }

  async function isAutoDownloadEnabled(): Promise<boolean> {
    const value = await window.electronAPI.config.get('autoDownloadUpdate') as boolean | undefined
    return value !== false
  }

  async function shouldSkipPrompt(version: string): Promise<boolean> {
    const dismissed = await window.electronAPI.config.get('dismissedUpdateVersion') as string | undefined
    return dismissed === version
  }

  async function snoozeVersion(version: string): Promise<void> {
    await window.electronAPI.config.set('dismissedUpdateVersion', version)
  }

  async function handleLater(version: string): Promise<void> {
    if (await isInstallOnQuitEnabled()) {
      const result = await window.electronAPI.updater.deferInstall()
      if (result.success) {
        toast.info(t('about.updateDeferredToast', { version }), 6000)
      } else {
        toast.warning(t('about.updateError'))
      }
      return
    }
    await snoozeVersion(version)
    toast.info(t('about.updateSnoozedToast'), 5000)
  }

  async function laterButtonLabel(): Promise<string> {
    return (await isInstallOnQuitEnabled())
      ? t('about.installOnQuit')
      : t('about.updateLater')
  }

  async function promptMacUpdateAvailable(version: string): Promise<void> {
    if (installPromptOpen) return
    if (await shouldSkipPrompt(version)) return
    if (version === lastMacAvailablePromptVersion) return

    installPromptOpen = true
    lastMacAvailablePromptVersion = version
    try {
      const goDownload = await showConfirm({
        title: t('about.newVersionAvailable', { version }),
        message: t('about.updateReadyMessageMac', { version }),
        confirmText: t('about.goToDownload'),
        cancelText: t('about.updateLater'),
        type: 'default',
      })
      if (goDownload) {
        window.open(getDownloadPageUrl(locale.value as LocaleType), '_blank')
      } else {
        await snoozeVersion(version)
      }
    } finally {
      installPromptOpen = false
    }
  }

  async function promptInstallReady(version: string): Promise<void> {
    if (installPromptOpen) return
    if (await shouldSkipPrompt(version)) return

    const deferred = await window.electronAPI.updater.isInstallDeferred()
    if (deferred.deferred && deferred.version === version) {
      return
    }

    installPromptOpen = true
    try {
      if (isMac) {
        const goDownload = await showConfirm({
          title: t('about.updateReadyTitle'),
          message: t('about.updateReadyMessageMac', { version }),
          confirmText: t('about.goToDownload'),
          cancelText: t('about.updateLater'),
          type: 'default',
        })
        if (goDownload) {
          window.open(getDownloadPageUrl(locale.value as LocaleType), '_blank')
        } else {
          await snoozeVersion(version)
        }
        return
      }

      const installOnQuit = await isInstallOnQuitEnabled()
      const installNow = await showConfirm({
        title: t('about.updateReadyTitle'),
        message: installOnQuit
          ? t('about.updateReadyMessage', { version })
          : t('about.updateReadyMessageNoQuit', { version }),
        confirmText: t('about.installAndRestart'),
        cancelText: await laterButtonLabel(),
        type: 'default',
      })
      if (installNow) {
        await window.electronAPI.updater.quitAndInstall()
      } else {
        await handleLater(version)
      }
    } finally {
      installPromptOpen = false
    }
  }

  async function handleStatus(status: UpdateStatusInfo): Promise<void> {
    const version = status.info?.version
    if (!version) return

    if (status.status === 'available') {
      if (isMac) {
        await promptMacUpdateAvailable(version)
      } else if (!(await isAutoDownloadEnabled()) && version !== lastAvailableToastVersion) {
        lastAvailableToastVersion = version
        toast.info(t('about.updateToastAvailable', { version }), 6000)
      }
      return
    }

    if (status.status === 'downloaded') {
      await promptInstallReady(version)
    }
  }

  function start(): void {
    if (isSteamBuild) return
    stop()

    cleanup = window.electronAPI.updater.onStatusChanged((status) => {
      void handleStatus(status).catch((err) => {
        log.warn('处理更新状态失败:', err)
      })
    })

    void window.electronAPI.updater.getStatus().then(async (status) => {
      if (status.status === 'downloaded' && status.info?.version) {
        await promptInstallReady(status.info.version)
      }
    }).catch(() => { /* ignore */ })
  }

  function stop(): void {
    cleanup?.()
    cleanup = null
  }

  return { start, stop }
}
