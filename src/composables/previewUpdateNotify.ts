/**
 * 开发态预览更新角标卡（无真实更新流程）。
 * DevTools：`window.__sailfishPreviewUpdateNotify('available' | 'downloading' | 'ready')`
 */
import { toast } from './useToast'
import {
  hideUpdateNotify,
  patchUpdateNotify,
  showUpdateNotify,
  type UpdateNotifyPhase,
} from './useUpdateNotify'

let progressTimer: ReturnType<typeof setInterval> | null = null

function clearProgressTimer(): void {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

function isMacPreview(): boolean {
  return /Mac/i.test(navigator.platform)
}

export function previewUpdateNotify(phase: UpdateNotifyPhase = 'ready'): void {
  clearProgressTimer()
  const version = '11.3.0-preview'
  const isMac = isMacPreview()

  if (phase === 'downloading') {
    let percent = 8
    showUpdateNotify(
      {
        phase: 'downloading',
        version,
        summary: '',
        isMac: false,
        installOnQuitEnabled: true,
        percent,
        transferred: Math.floor(40 * 1024 * 1024 * (percent / 100)),
        total: 40 * 1024 * 1024,
      },
      {
        onPrimary: async () => {},
        onSecondary: async () => {},
        onChangelog: () => toast.info('预览：打开更新日志', 2500),
        onDismiss: async () => {
          clearProgressTimer()
          hideUpdateNotify()
          toast.info('预览：已关闭下载中卡片', 2500)
        },
      },
    )
    progressTimer = setInterval(() => {
      percent = Math.min(96, percent + 7)
      patchUpdateNotify({
        percent,
        transferred: Math.floor(40 * 1024 * 1024 * (percent / 100)),
        total: 40 * 1024 * 1024,
      })
      if (percent >= 96) clearProgressTimer()
    }, 400)
    return
  }

  if (phase === 'available') {
    showUpdateNotify(
      {
        phase: 'available',
        version,
        summary: '预览摘要：非打断角标卡 · 本地秘书待办 · IM 图文上下文',
        isMac,
        installOnQuitEnabled: true,
        percent: 0,
        transferred: 0,
        total: 0,
      },
      {
        onPrimary: async () => {
          toast.info(isMac ? '预览：前往下载' : '预览：开始下载 → 切到 downloading', 2500)
          if (!isMac) previewUpdateNotify('downloading')
        },
        onSecondary: async () => {
          hideUpdateNotify()
          toast.info('预览：稍后提醒', 2500)
        },
        onChangelog: () => toast.info('预览：打开更新日志', 2500),
        onDismiss: async () => {
          hideUpdateNotify()
          toast.info('预览：已关闭', 2500)
        },
      },
    )
    return
  }

  // ready
  showUpdateNotify(
    {
      phase: 'ready',
      version,
      summary: '',
      isMac: false,
      installOnQuitEnabled: true,
      percent: 100,
      transferred: 0,
      total: 0,
    },
    {
      onPrimary: async () => {
        toast.info('预览：安装并重启（未真正执行）', 3000)
      },
      onSecondary: async () => {
        hideUpdateNotify()
        toast.info('预览：退出时安装', 2500)
      },
      onChangelog: () => toast.info('预览：打开更新日志', 2500),
      onDismiss: async () => {
        hideUpdateNotify()
        toast.info('预览：稍后再说', 2500)
      },
    },
  )
}

export function installUpdateNotifyPreviewGlobal(): void {
  if (!import.meta.env.DEV) return
  ;(window as unknown as { __sailfishPreviewUpdateNotify?: typeof previewUpdateNotify })
    .__sailfishPreviewUpdateNotify = previewUpdateNotify
}
