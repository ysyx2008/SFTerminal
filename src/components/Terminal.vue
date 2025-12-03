<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { getTheme } from '../themes'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  tabId: string
  ptyId: string
  type: 'local' | 'ssh'
  isActive: boolean
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: XTerm | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let unsubscribe: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let isDisposed = false
let isPasting = false
let keyDownHandler: ((event: KeyboardEvent) => void) | null = null

// 右键菜单状态
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  hasSelection: false,
  selectedText: ''
})

// 初始化终端
onMounted(async () => {
  if (!terminalRef.value) return

  // 获取主题
  const theme = getTheme(configStore.currentTheme)
  const settings = configStore.terminalSettings

  // 创建终端实例
  terminal = new XTerm({
    theme,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    convertEol: true
  })

  // 加载插件
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  const webLinksAddon = new WebLinksAddon()

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(webLinksAddon)

  // 挂载到 DOM
  terminal.open(terminalRef.value)

  // 适配大小 - 使用 setTimeout 确保 DOM 完全渲染和布局完成
  await nextTick()
  setTimeout(async () => {
    if (fitAddon && terminal && terminalRef.value) {
      // 检查容器是否有有效尺寸
      const rect = terminalRef.value.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        fitAddon.fit()
        // 更新后端 PTY 大小
        const { cols, rows } = terminal
        await terminalStore.resizeTerminal(props.tabId, cols, rows)
        terminal.focus()
      }
    }
  }, 100)

  // 监听用户输入
  terminal.onData(data => {
    terminalStore.writeToTerminal(props.tabId, data)
  })

  // 处理 Ctrl+C 复制
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Ctrl+C 复制选中内容
    if ((event.ctrlKey || event.metaKey) && event.key === 'c' && event.type === 'keydown') {
      const selection = terminal.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
        return false // 阻止默认行为（不发送 SIGINT）
      }
      // 没有选中内容时，让 Ctrl+C 发送到终端（作为中断信号）
      return true
    }
    return true
  })

  // 处理 Ctrl+V 粘贴 - 监听 DOM 事件
  const handlePaste = async () => {
    if (isPasting || isDisposed || !terminal) return
    isPasting = true
    
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        terminalStore.writeToTerminal(props.tabId, text)
      }
    } catch (e) {
      // 忽略错误
    } finally {
      setTimeout(() => { isPasting = false }, 200)
    }
  }

  keyDownHandler = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      event.preventDefault()
      event.stopPropagation()
      handlePaste()
    }
  }

  if (terminalRef.value) {
    terminalRef.value.addEventListener('keydown', keyDownHandler, true)
  }

  // 订阅后端数据
  if (props.type === 'local') {
    unsubscribe = window.electronAPI.pty.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })
  } else {
    unsubscribe = window.electronAPI.ssh.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })
  }

  // 监听选中文本变化
  terminal.onSelectionChange(() => {
    if (terminal) {
      const selection = terminal.getSelection()
      terminalStore.updateSelectedText(props.tabId, selection || '')
    }
  })

  // 监听窗口大小变化
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && props.isActive) {
      fitAddon.fit()
      if (terminal) {
        terminalStore.resizeTerminal(props.tabId, terminal.cols, terminal.rows)
      }
    }
  })
  resizeObserver.observe(terminalRef.value)
})

// 清理
onUnmounted(() => {
  // 先标记为已销毁，防止后续回调执行
  isDisposed = true
  
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (keyDownHandler && terminalRef.value) {
    terminalRef.value.removeEventListener('keydown', keyDownHandler, true)
    keyDownHandler = null
  }
  if (terminal) {
    terminal.dispose()
    terminal = null
  }
  fitAddon = null
  searchAddon = null
})

// 当标签页激活时，重新适配大小并聚焦
watch(
  () => props.isActive,
  async active => {
    if (active && terminal && fitAddon && terminalRef.value) {
      await nextTick()
      setTimeout(() => {
        if (fitAddon && terminal && terminalRef.value) {
          const rect = terminalRef.value.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            fitAddon.fit()
            terminal.focus()
            terminalStore.resizeTerminal(props.tabId, terminal.cols, terminal.rows)
          }
        }
      }, 50)
    }
  },
  { immediate: true }
)

// 监听主题变化
watch(
  () => configStore.currentTheme,
  themeName => {
    if (terminal) {
      const theme = getTheme(themeName)
      terminal.options.theme = theme
    }
  }
)

// 右键菜单处理
const handleContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  
  const selection = terminal?.getSelection() || ''
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    hasSelection: selection.length > 0,
    selectedText: selection
  }
}

const hideContextMenu = () => {
  contextMenu.value.visible = false
  // 让终端重新获得焦点
  nextTick(() => {
    terminal?.focus()
  })
}

const menuCopy = async () => {
  if (contextMenu.value.selectedText) {
    await navigator.clipboard.writeText(contextMenu.value.selectedText)
  }
  hideContextMenu()
}

const menuPaste = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      terminalStore.writeToTerminal(props.tabId, text)
    }
  } catch (e) {
    // 忽略错误
  }
  hideContextMenu()
}

const menuSendToAi = () => {
  if (contextMenu.value.selectedText) {
    terminalStore.sendToAi(contextMenu.value.selectedText)
  }
  hideContextMenu()
}

const menuClear = () => {
  terminal?.clear()
  hideContextMenu()
}

// 点击其他地方关闭菜单
const handleGlobalClick = () => {
  hideContextMenu()
}

// 暴露方法供外部调用
defineExpose({
  focus: () => terminal?.focus(),
  search: (text: string) => searchAddon?.findNext(text),
  clear: () => terminal?.clear()
})
</script>

<template>
  <div 
    ref="terminalRef" 
    class="terminal" 
    @contextmenu="handleContextMenu"
    @click="hideContextMenu"
  ></div>
  
  <!-- 右键菜单 -->
  <Teleport to="body">
    <div 
      v-if="contextMenu.visible" 
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <div 
        class="menu-item"
        :class="{ disabled: !contextMenu.hasSelection }"
        @click="contextMenu.hasSelection && menuSendToAi()"
      >
        <span class="menu-icon">🤖</span>
        <span>发送到 AI 分析</span>
      </div>
      <div class="menu-divider"></div>
      <div 
        class="menu-item" 
        :class="{ disabled: !contextMenu.hasSelection }"
        @click="contextMenu.hasSelection && menuCopy()"
      >
        <span class="menu-icon">📋</span>
        <span>复制</span>
        <span class="shortcut">Ctrl+C</span>
      </div>
      <div class="menu-item" @click="menuPaste()">
        <span class="menu-icon">📄</span>
        <span>粘贴</span>
        <span class="shortcut">Ctrl+V</span>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="menuClear()">
        <span class="menu-icon">🗑️</span>
        <span>清屏</span>
      </div>
    </div>
    <div 
      v-if="contextMenu.visible" 
      class="context-menu-overlay" 
      @click="hideContextMenu"
    ></div>
  </Teleport>
</template>

<style scoped>
.terminal {
  width: 100%;
  height: 100%;
  padding: 8px;
}

.terminal :deep(.xterm) {
  height: 100%;
}

.terminal :deep(.xterm-viewport) {
  overflow-y: auto;
}

.terminal :deep(.xterm-screen) {
  height: 100%;
}

/* 右键菜单遮罩层 */
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 999;
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  background: var(--bg-secondary, #2d2d30);
  border: 1px solid var(--border-color, #404040);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 13px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-primary, #e0e0e0);
  transition: background-color 0.15s;
}

.menu-item:hover:not(.disabled) {
  background: var(--bg-hover, #094771);
}

.menu-item.disabled {
  color: var(--text-disabled, #6e6e6e);
  cursor: not-allowed;
}

.menu-icon {
  width: 20px;
  margin-right: 8px;
  font-size: 14px;
}

.shortcut {
  margin-left: auto;
  color: var(--text-secondary, #888);
  font-size: 11px;
}

.menu-divider {
  height: 1px;
  background: var(--border-color, #404040);
  margin: 4px 0;
}
</style>

