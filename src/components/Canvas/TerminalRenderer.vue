<script setup lang="ts">
/**
 * Canvas TerminalRenderer
 * 
 * 只读 xterm.js 实例，展示 Agent exec 工具的命令执行过程。
 * 通过 Canvas store 的 terminalEntries 队列驱动。
 * 
 * 关键：Canvas 打开时有 300ms CSS 过渡动画，xterm 必须等动画结束后
 * 再 fit + 写入内容，否则会按动画中间的窄宽度换行。
 */
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useConfigStore } from '../../stores/config'
import { useCanvasStore, type TerminalEntry } from '../../stores/canvas'
import { getIntegratedTheme } from '../../themes'
import '@xterm/xterm/css/xterm.css'

const TRANSITION_DURATION = 350

const props = defineProps<{
  tabId: string
}>()

const configStore = useConfigStore()
const canvasStore = useCanvasStore()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: XTerm | null = null
let fitAddon: FitAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObserver: ResizeObserver | null = null
let processedCount = 0
let ready = false

function initTerminal() {
  if (!terminalRef.value) return

  const theme = getIntegratedTheme(configStore.uiTheme)
  const settings = configStore.terminalSettings

  terminal = new XTerm({
    theme,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    cursorBlink: false,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowProposedApi: true,
    convertEol: true,
    disableStdin: true,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)

  try {
    webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      webglAddon?.dispose()
      webglAddon = null
    })
    terminal.loadAddon(webglAddon)
  } catch {
    webglAddon = null
  }

  // 等 Canvas 的 CSS 过渡动画完成后再 fit + 写入内容
  setTimeout(() => {
    if (fitAddon && terminal && terminalRef.value) {
      const rect = terminalRef.value.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        fitAddon.fit()
      }
    }
    ready = true
    processedCount = 0
    processEntries(canvasStore.getTerminalEntries(props.tabId))
  }, TRANSITION_DURATION)

  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && terminal && ready) {
      try { fitAddon.fit() } catch { /* ignore */ }
    }
  })
  if (terminalRef.value) {
    resizeObserver.observe(terminalRef.value)
  }
}

function processEntries(entries: TerminalEntry[]) {
  if (!terminal || !ready) return
  const newEntries = entries.slice(processedCount)
  for (const entry of newEntries) {
    writeEntry(entry)
  }
  processedCount = entries.length
}

function writeEntry(entry: TerminalEntry) {
  if (!terminal) return
  switch (entry.type) {
    case 'command':
      terminal.write(`\x1b[1;32m$ \x1b[0m\x1b[1m${entry.content}\x1b[0m\r\n`)
      break
    case 'output':
      terminal.write(entry.content)
      if (!entry.content.endsWith('\n')) {
        terminal.write('\r\n')
      }
      break
    case 'error':
      terminal.write(`\x1b[1;31m${entry.content}\x1b[0m\r\n`)
      break
    case 'info':
      terminal.write(`\x1b[2m${entry.content}\x1b[0m\r\n`)
      break
  }
}

onMounted(() => {
  initTerminal()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  webglAddon?.dispose()
  terminal?.dispose()
  terminal = null
  fitAddon = null
  webglAddon = null
})

watch(
  () => canvasStore.getTerminalEntries(props.tabId),
  (entries) => {
    processEntries(entries)
  },
  { deep: true }
)

watch(
  () => configStore.uiTheme,
  () => {
    if (terminal) {
      terminal.options.theme = getIntegratedTheme(configStore.uiTheme)
    }
  }
)

defineExpose({
  fit() {
    if (fitAddon && terminal) {
      try { fitAddon.fit() } catch { /* ignore */ }
    }
  }
})
</script>

<template>
  <div class="terminal-renderer" ref="terminalRef"></div>
</template>

<style scoped>
.terminal-renderer {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.terminal-renderer :deep(.xterm) {
  height: 100%;
  padding: 4px;
}
</style>
