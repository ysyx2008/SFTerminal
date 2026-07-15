import { reactive } from 'vue'

/** 非打断更新角标卡阶段 */
export type UpdateNotifyPhase = 'available' | 'downloading' | 'ready'

export interface UpdateNotifyModel {
  visible: boolean
  phase: UpdateNotifyPhase
  version: string
  summary: string
  isMac: boolean
  installOnQuitEnabled: boolean
  percent: number
  transferred: number
  total: number
  primaryBusy: boolean
}

export interface UpdateNotifyHandlers {
  onPrimary: () => void | Promise<void>
  onSecondary: () => void | Promise<void>
  onChangelog: () => void
  onDismiss: () => void | Promise<void>
}

const model = reactive<UpdateNotifyModel>({
  visible: false,
  phase: 'available',
  version: '',
  summary: '',
  isMac: false,
  installOnQuitEnabled: true,
  percent: 0,
  transferred: 0,
  total: 0,
  primaryBusy: false,
})

let handlers: UpdateNotifyHandlers | null = null

export function showUpdateNotify(
  patch: Partial<Omit<UpdateNotifyModel, 'visible' | 'primaryBusy'>> & {
    phase: UpdateNotifyPhase
    version: string
  },
  nextHandlers: UpdateNotifyHandlers,
): void {
  handlers = nextHandlers
  Object.assign(model, {
    ...patch,
    visible: true,
    primaryBusy: false,
  })
}

export function patchUpdateNotify(
  patch: Partial<Omit<UpdateNotifyModel, 'visible'>>,
): void {
  if (!model.visible) return
  Object.assign(model, patch)
}

export function hideUpdateNotify(): void {
  model.visible = false
  model.primaryBusy = false
  handlers = null
}

async function run(fn: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!fn) return
  await fn()
}

export function useUpdateNotify() {
  const runPrimary = async () => {
    if (model.primaryBusy) return
    model.primaryBusy = true
    try {
      await run(handlers?.onPrimary)
    } finally {
      model.primaryBusy = false
    }
  }

  const runSecondary = async () => {
    if (model.primaryBusy) return
    await run(handlers?.onSecondary)
  }

  const runChangelog = () => {
    handlers?.onChangelog()
  }

  const runDismiss = async () => {
    if (model.primaryBusy) return
    await run(handlers?.onDismiss)
  }

  return {
    model,
    runPrimary,
    runSecondary,
    runChangelog,
    runDismiss,
  }
}
