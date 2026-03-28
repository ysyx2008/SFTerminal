/**
 * Canvas 预览面板状态管理
 *
 * 管理独立助手模式下右侧 Canvas 面板的显示状态。
 * Canvas 由 Agent step 事件驱动：exec 工具触发打开，任务完成触发关闭。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CanvasRendererType } from '@shared/types'
import type { AgentStep } from '@shared/types'

/** 写入 Canvas 的终端数据条目 */
export interface TerminalEntry {
  type: 'command' | 'output' | 'error' | 'info'
  content: string
  timestamp: number
}

export const useCanvasStore = defineStore('canvas', () => {
  /** 各 tab 的 Canvas 状态（key = tabId） */
  const states = ref<Map<string, {
    visible: boolean
    renderer: CanvasRendererType | null
    title: string
    /** 终端条目队列（TerminalRenderer 消费） */
    terminalEntries: TerminalEntry[]
    /** 通用内容（文档 HTML、图片 URL 等） */
    content: string
  }>>(new Map())

  /** 分割比例（所有 tab 共用，0-1 范围，表示 Canvas 占比） */
  const splitRatio = ref(0.5)

  /** Canvas 关闭延迟定时器 */
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function getState(tabId: string) {
    if (!states.value.has(tabId)) {
      states.value.set(tabId, {
        visible: false,
        renderer: null,
        title: '',
        terminalEntries: [],
        content: ''
      })
    }
    return states.value.get(tabId)!
  }

  function isVisible(tabId: string): boolean {
    return states.value.get(tabId)?.visible ?? false
  }

  function getRenderer(tabId: string): CanvasRendererType | null {
    return states.value.get(tabId)?.renderer ?? null
  }

  function getTitle(tabId: string): string {
    return states.value.get(tabId)?.title ?? ''
  }

  function getTerminalEntries(tabId: string): TerminalEntry[] {
    return states.value.get(tabId)?.terminalEntries ?? []
  }

  /**
   * 打开 Canvas
   */
  function open(tabId: string, renderer: CanvasRendererType, title: string) {
    cancelPendingClose(tabId)
    const state = getState(tabId)
    if (state.renderer !== renderer) {
      state.terminalEntries = []
      state.content = ''
    }
    state.visible = true
    state.renderer = renderer
    state.title = title
  }

  /**
   * 关闭 Canvas
   */
  function close(tabId: string) {
    const state = states.value.get(tabId)
    if (state) {
      state.visible = false
    }
    cancelPendingClose(tabId)
  }

  /**
   * 延迟关闭（任务完成后给用户留时间看最后输出）
   */
  function closeDelayed(tabId: string, delayMs = 0) {
    if (delayMs <= 0) {
      close(tabId)
      return
    }
    cancelPendingClose(tabId)
    closeTimers.set(tabId, setTimeout(() => {
      close(tabId)
      closeTimers.delete(tabId)
    }, delayMs))
  }

  function cancelPendingClose(tabId: string) {
    const timer = closeTimers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      closeTimers.delete(tabId)
    }
  }

  /**
   * 推送终端数据
   */
  function pushTerminalEntry(tabId: string, entry: Omit<TerminalEntry, 'timestamp'>) {
    const state = getState(tabId)
    state.terminalEntries.push({ ...entry, timestamp: Date.now() })
  }

  /**
   * 更新通用内容（文档 HTML 等）
   */
  function updateContent(tabId: string, content: string) {
    const state = getState(tabId)
    state.content = content
  }

  /**
   * 处理 Agent step 事件，自动驱动 Canvas
   * 在 useAgentMode composable 中调用
   * 
   * 注意：普通 exec 命令不触发 Canvas（结果已在对话中显示）。
   * Canvas 留给更有价值的场景：终端技能（PTY）、Word/Excel 预览、浏览器截图等。
   */
  function handleAgentStep(tabId: string, step: AgentStep) {
    if (!isVisible(tabId)) return

    // Canvas 已打开时，追加终端数据
    if (step.type === 'tool_call' && step.toolName === 'exec') {
      const command = typeof step.toolArgs?.command === 'string' ? step.toolArgs.command : ''
      if (command) {
        pushTerminalEntry(tabId, { type: 'command', content: command })
      }
    }

    if (step.type === 'tool_result' && step.toolName === 'exec') {
      const output = step.toolResult ?? ''
      if (output) {
        pushTerminalEntry(tabId, { type: 'output', content: output })
      }
    }
  }

  /**
   * 处理 Agent 完成事件
   */
  function handleAgentComplete(tabId: string) {
    if (isVisible(tabId)) {
      close(tabId)
    }
  }

  /**
   * 清理 tab 状态
   */
  function cleanup(tabId: string) {
    cancelPendingClose(tabId)
    states.value.delete(tabId)
  }

  return {
    states,
    splitRatio,
    isVisible,
    getRenderer,
    getTitle,
    getTerminalEntries,
    open,
    close,
    closeDelayed,
    pushTerminalEntry,
    updateContent,
    handleAgentStep,
    handleAgentComplete,
    cleanup
  }
})
