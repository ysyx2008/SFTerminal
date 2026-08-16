import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CrashEvent } from '@sailfish/shared-types'

const showMessageBox = vi.fn()
const writeText = vi.fn()
const reload = vi.fn()

vi.mock('electron', () => ({
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  clipboard: { writeText: (text: string) => writeText(text) },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: (id: number) => (id > 0 ? { id, reload } : null) },
}))

vi.mock('../../../i18n/main-i18n', () => ({ t: (key: string) => key }))

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

let crashListener: ((event: CrashEvent) => void) | null = null
vi.mock('../collector', () => ({
  onCrashRecorded: (listener: (event: CrashEvent) => void) => {
    crashListener = listener
    return () => { crashListener = null }
  },
}))

import { CrashNotifier } from '../notifier'

function makeEvent(overrides: Partial<CrashEvent> = {}): CrashEvent {
  return {
    at: new Date().toISOString(),
    appVersion: '11.6.0',
    platform: 'win32',
    kind: 'renderer-gone',
    processType: 'renderer',
    webContentsId: 1,
    reason: 'crashed',
    ...overrides,
  }
}

/** 事件监听是同步触发的，弹窗是异步的，等一拍让它跑完 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('CrashNotifier', () => {
  let enabled: boolean
  let notifier: CrashNotifier

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    showMessageBox.mockReset().mockResolvedValue({ response: 2, checkboxChecked: false })
    writeText.mockReset()
    reload.mockReset()
    enabled = true
    notifier = new CrashNotifier({
      isEnabled: () => enabled,
      setEnabled: (v) => { enabled = v },
      getSummaryText: async () => '崩溃摘要正文',
    })
    notifier.start()
  })

  afterEach(() => {
    notifier.stop()
    vi.useRealTimers()
  })

  it('界面崩溃会打断用户——这时他已经动不了了', async () => {
    crashListener!(makeEvent())
    await flush()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('子进程崩溃与主进程异常不弹窗，用户看不见的部分不打断他', async () => {
    crashListener!(makeEvent({ kind: 'child-gone', serviceName: 'Embedding Worker' }))
    crashListener!(makeEvent({ kind: 'main-uncaught', message: 'boom' }))
    await flush()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('嵌入内容崩溃不弹窗——预览坏了不该按整个界面崩了处理', async () => {
    crashListener!(makeEvent({ processType: 'webview', webContentsId: 42 }))
    await flush()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('选择重载只重载崩掉的那个界面', async () => {
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    crashListener!(makeEvent({ webContentsId: 7 }))
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('同类问题短时间内只说一次', async () => {
    crashListener!(makeEvent())
    await flush()
    crashListener!(makeEvent())
    await flush()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('过了冷静期同类问题才会再提', async () => {
    crashListener!(makeEvent())
    await flush()
    vi.advanceTimersByTime(6 * 60 * 1000)
    crashListener!(makeEvent())
    await flush()
    expect(showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('单次运行的提示有上限，崩溃循环不会变成弹窗轰炸', async () => {
    // 每次都越过冷静期，只剩「单次运行上限」这一道闸
    for (let i = 0; i < 5; i++) {
      crashListener!(makeEvent())
      await flush()
      vi.advanceTimersByTime(6 * 60 * 1000)
    }
    expect(showMessageBox.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('关掉开关后彻底不提示', async () => {
    enabled = false
    crashListener!(makeEvent())
    await flush()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('用户勾选「不再提示」即永久关闭', async () => {
    showMessageBox.mockResolvedValue({ response: 2, checkboxChecked: true })
    crashListener!(makeEvent())
    await flush()
    expect(enabled).toBe(false)
  })

  it('选择复制摘要就把正文放进剪贴板，并给出回执', async () => {
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    crashListener!(makeEvent())
    await flush()
    expect(writeText).toHaveBeenCalledWith('崩溃摘要正文')
    // 一次是崩溃提示，一次是「已复制」回执
    expect(showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('上次正常退出时不补报', async () => {
    await notifier.notifyPreviousCrash({ lastExitWasCrash: false, consecutiveCrashCount: 0 })
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('上次异常退出会补报，连续多次时换用更重的说法', async () => {
    await notifier.notifyPreviousCrash({
      lastExitWasCrash: true,
      consecutiveCrashCount: 3,
      previousVersion: '11.6.0',
    })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const options = showMessageBox.mock.calls[0][0] as { detail: string }
    expect(options.detail).toBe('crash.previousDetailRepeated')
  })
})
