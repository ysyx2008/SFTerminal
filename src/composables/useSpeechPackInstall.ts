/**
 * 语音识别模型包安装状态（模块级共享）
 *
 * 安装在主进程执行，不随设置页卸载取消。进度与 busy 状态提到此处，
 * 关闭设置后再打开仍可看到进度；完成时若设置页未打开则 toast。
 */
import { computed, ref } from 'vue'
import i18n from '../i18n'
import { toast } from './useToast'
import { refreshSpeechPackAvailability } from './useSpeechRecognition'

export interface SpeechPackProgressState {
  phase?: string
  percent: number
  message: string
  downloaded?: number
  total?: number
  bytesPerSecond?: number
  etaSeconds?: number
}

export interface SpeechPackStatusView {
  available: boolean
  source: string
  packVersion: string | null
  recommendedVersion: string
  approxSizeBytes: number
}

const busy = ref(false)
const error = ref('')
const progress = ref<SpeechPackProgressState>({ percent: 0, message: '' })
const status = ref<SpeechPackStatusView | null>(null)
const urls = ref<{ github: string; oss: string; version: string } | null>(null)

let progressUnsub: (() => void) | null = null
/** AiSettings 语音区块是否挂载（>0 表示用户正在看设置进度） */
let uiRetainCount = 0
let installPromise: Promise<void> | null = null

function t(key: string, params?: Record<string, unknown>): string {
  return String(i18n.global.t(key, params as Record<string, unknown>))
}

export function retainSpeechPackInstallUi(): void {
  uiRetainCount++
}

export function releaseSpeechPackInstallUi(): void {
  uiRetainCount = Math.max(0, uiRetainCount - 1)
}

function ensureProgressSub(): void {
  if (progressUnsub) return
  progressUnsub = window.electronAPI.speech.onPackProgress((p) => {
    progress.value = {
      phase: p.phase,
      percent: p.percent,
      message: p.message || '',
      downloaded: p.downloaded,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
      etaSeconds: p.etaSeconds,
    }
  })
}

function stopProgressSub(): void {
  progressUnsub?.()
  progressUnsub = null
}

export function formatSpeechPackBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)))
  return `${parseFloat((n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1))} ${sizes[i]}`
}

function formatEta(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return t('settings.speechPack.etaCalculating')
  }
  if (seconds < 60) {
    return t('settings.speechPack.etaSeconds', { n: Math.ceil(seconds) })
  }
  const m = Math.floor(seconds / 60)
  const s = Math.ceil(seconds % 60)
  if (s <= 0) {
    return t('settings.speechPack.etaMinutesOnly', { m })
  }
  return t('settings.speechPack.etaMinutes', { m, s })
}

const progressDetail = computed(() => {
  const p = progress.value
  if (p.phase !== 'download') return ''
  if (p.downloaded == null || p.total == null || p.total <= 0) return ''
  return t('settings.speechPack.downloadingDetail', {
    downloaded: formatSpeechPackBytes(p.downloaded),
    total: formatSpeechPackBytes(p.total),
    speed: formatSpeechPackBytes(p.bytesPerSecond || 0),
    eta: formatEta(p.etaSeconds),
  })
})

export async function refreshSpeechPackStatus(): Promise<void> {
  try {
    const [packStatus, packUrls] = await Promise.all([
      window.electronAPI.speech.getPackStatus(),
      window.electronAPI.speech.getPackDownloadUrls(),
    ])
    status.value = {
      available: packStatus.available,
      source: packStatus.source,
      packVersion: packStatus.packVersion,
      recommendedVersion: packStatus.recommendedVersion,
      approxSizeBytes: packStatus.approxSizeBytes,
    }
    urls.value = packUrls
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function notifyIfBackground(ok: boolean, message: string): void {
  if (uiRetainCount > 0) return
  if (ok) toast.success(message)
  else toast.error(message)
}

export async function installSpeechPackOnline(): Promise<void> {
  if (installPromise) {
    await installPromise
    return
  }

  busy.value = true
  error.value = ''
  progress.value = { percent: 0, message: t('settings.speechPack.installing') }
  ensureProgressSub()

  installPromise = (async () => {
    try {
      const result = await window.electronAPI.speech.installPack()
      if (!result.success) {
        const msg = result.error || t('settings.speechPack.installFailed')
        error.value = msg
        notifyIfBackground(false, msg)
        return
      }
      await refreshSpeechPackStatus()
      await refreshSpeechPackAvailability()
      notifyIfBackground(true, t('settings.speechPack.installDone'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      error.value = msg
      notifyIfBackground(false, msg)
    } finally {
      busy.value = false
      installPromise = null
      stopProgressSub()
    }
  })()

  await installPromise
}

export async function importSpeechPack(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  ensureProgressSub()
  try {
    const result = await window.electronAPI.speech.importPack()
    if (result.cancelled) return
    if (!result.success) {
      error.value = result.error || t('settings.speechPack.importFailed')
      return
    }
    await refreshSpeechPackStatus()
    await refreshSpeechPackAvailability()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    stopProgressSub()
  }
}

export async function uninstallSpeechPack(): Promise<void> {
  if (busy.value) return
  if (!confirm(t('settings.speechPack.confirmUninstall'))) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.speech.uninstallPack()
    if (!result.success) {
      error.value = result.error || t('settings.speechPack.uninstallFailed')
      return
    }
    await refreshSpeechPackStatus()
    await refreshSpeechPackAvailability()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

export function openSpeechPackUrl(which: 'github' | 'oss'): void {
  const url = which === 'github' ? urls.value?.github : urls.value?.oss
  if (url) window.open(url, '_blank')
}

export function useSpeechPackInstall() {
  return {
    busy,
    error,
    progress,
    progressDetail,
    status,
    urls,
    refreshSpeechPackStatus,
    installSpeechPackOnline,
    importSpeechPack,
    uninstallSpeechPack,
    openSpeechPackUrl,
    formatSpeechPackBytes,
    retainSpeechPackInstallUi,
    releaseSpeechPackInstallUi,
  }
}
