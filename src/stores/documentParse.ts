/**
 * 文档解析进度全局状态
 *
 * IPC 监听只在 store 创建时挂一次，避免每个 AiPanel 实例各自监听
 * 同一事件被 N 次分发（N = 已挂载 tab 数）。
 *
 * 状态按 requestId 索引；每个 useDocumentUpload 实例持有自己的
 * requestId 集合，通过 store 取自己关心的进度卡片。
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { DocumentParseProgress } from '@shared/types'

export type ParsingDocument = DocumentParseProgress

const SUCCESS_LINGER_MS = 600
const FAILURE_LINGER_MS = 3000

export const useDocumentParseStore = defineStore('documentParse', () => {
  // Map<requestId, ParsingDocument[]>
  const parseStateByRequestId = reactive(new Map<string, ParsingDocument[]>())
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let listenerInstalled = false

  function installListener() {
    if (listenerInstalled) return
    if (!window.electronAPI?.document?.onParseProgress) return
    listenerInstalled = true
    window.electronAPI.document.onParseProgress((progress) => {
      const list = parseStateByRequestId.get(progress.requestId)
      if (!list) return
      const existing = list.find(doc => doc.fileIndex === progress.fileIndex)
      if (existing) {
        Object.assign(existing, progress)
      } else {
        list.push({ ...progress })
      }
    })
  }

  function startTracking(requestId: string, files: Array<{ name: string; size: number }>) {
    installListener()
    const timer = cleanupTimers.get(requestId)
    if (timer) {
      clearTimeout(timer)
      cleanupTimers.delete(requestId)
    }
    parseStateByRequestId.set(
      requestId,
      files.map((file, fileIndex) => ({
        requestId,
        fileIndex,
        fileCount: files.length,
        filename: file.name,
        fileSize: file.size,
        status: 'queued' as const,
        phase: 'queued' as const,
        percent: 0
      }))
    )
  }

  function getDocs(requestId: string): ParsingDocument[] {
    return parseStateByRequestId.get(requestId) || []
  }

  function finishTracking(requestId: string, opts?: { delay?: number }) {
    const delay = opts?.delay ?? SUCCESS_LINGER_MS
    scheduleCleanup(requestId, delay)
  }

  function failTracking(requestId: string, error: unknown) {
    const list = parseStateByRequestId.get(requestId)
    if (list) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      for (const doc of list) {
        if (doc.status !== 'completed') {
          doc.status = 'failed'
          doc.phase = 'failed'
          doc.percent = 100
          doc.error = errorMessage
        }
      }
    }
    scheduleCleanup(requestId, FAILURE_LINGER_MS)
  }

  function scheduleCleanup(requestId: string, delay: number) {
    const existing = cleanupTimers.get(requestId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      parseStateByRequestId.delete(requestId)
      cleanupTimers.delete(requestId)
    }, delay)
    cleanupTimers.set(requestId, timer)
  }

  return {
    parseStateByRequestId,
    startTracking,
    finishTracking,
    failTracking,
    getDocs
  }
})
