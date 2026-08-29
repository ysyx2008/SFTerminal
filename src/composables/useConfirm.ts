import { ref, reactive } from 'vue'

export interface ConfirmDialogOptions {
  title: string
  message: string
  detail?: string
  confirmText?: string
  cancelText?: string
  /**
   * 中性按钮文案（可选）。设置后 dialog 会在 cancel 与 confirm 之间渲染第三个按钮。
   * 用户点击该按钮时不会 resolve confirm（promise 仍 resolve false），但会触发 onNeutral 回调。
   * 适用于「主动操作但既非确认也非取消」的场景，例如「打开设置」「查看详情」。
   */
  neutralText?: string
  /** 中性按钮的回调；点击 neutral 按钮时同步触发，promise 仍 resolve false。 */
  onNeutral?: () => void
  type?: 'default' | 'danger' | 'warning'
  /** 必须打出这几个字才能确认。不设则只点按钮即可。 */
  typedPhrase?: string
  showCancel?: boolean
  fileInfo?: {
    name?: string
    size?: string
    count?: number
    type?: string
  }
}

// 全局状态
const show = ref(false)
const options = reactive<ConfirmDialogOptions>({
  title: '',
  message: '',
  type: 'default'
})

let resolvePromise: ((value: boolean) => void) | null = null

/**
 * 显示确认对话框
 */
export function useConfirm() {
  const confirm = (opts: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      Object.assign(options, {
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        confirmText: opts.confirmText,
        cancelText: opts.cancelText,
        neutralText: opts.neutralText,
        onNeutral: opts.onNeutral,
        type: opts.type || 'default',
        typedPhrase: opts.typedPhrase,
        showCancel: opts.showCancel,
        fileInfo: opts.fileInfo
      })
      show.value = true
      resolvePromise = resolve
    })
  }

  const handleConfirm = () => {
    show.value = false
    resolvePromise?.(true)
    resolvePromise = null
  }

  const handleCancel = () => {
    show.value = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  const handleNeutral = () => {
    show.value = false
    try {
      options.onNeutral?.()
    } finally {
      resolvePromise?.(false)
      resolvePromise = null
    }
  }

  const handleClose = () => {
    show.value = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  return {
    show,
    options,
    confirm,
    handleConfirm,
    handleCancel,
    handleNeutral,
    handleClose
  }
}

// 便捷方法
export async function showConfirm(opts: ConfirmDialogOptions): Promise<boolean> {
  const { confirm } = useConfirm()
  return confirm(opts)
}

// 删除确认快捷方法
export async function confirmDelete(
  name: string, 
  type: string = '文件',
  size?: string
): Promise<boolean> {
  return showConfirm({
    title: `删除${type}`,
    message: `确定要删除此${type}吗？此操作无法撤销。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消',
    fileInfo: {
      name,
      type,
      size
    }
  })
}

// 警告提示快捷方法
export async function showAlert(title: string, message: string): Promise<void> {
  await showConfirm({
    title,
    message,
    type: 'warning',
    showCancel: false,
    confirmText: '确定'
  })
}
