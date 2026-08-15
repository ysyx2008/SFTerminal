<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

// Windows 自绘标题栏的三个按钮：最小化 / 最大化-还原 / 关闭。
// 仅在 Windows 平台渲染（由父组件 v-if 控制），其他平台不会挂载本组件。
// 样式参照 Win11 caption controls：46×32，hover 浅灰；关闭按钮 hover 红色。

const isMaximized = ref(false)

let cleanupMaximizeListener: (() => void) | null = null

onMounted(() => {
  // 先订阅事件再查询初始状态：避免在 await 期间窗口被最大化/还原导致中间事件丢失。
  // 任何在订阅 → 查询窗口期触发的 maximize/unmaximize 事件都会更新 ref，最后由 isMaximized()
  // 的 resolve 值与事件状态保持一致（事件是 sync 的，无穷套娃风险）。
  cleanupMaximizeListener = window.electronAPI.window.onMaximizeStateChange((m) => {
    isMaximized.value = m
  })
  window.electronAPI.window.isMaximized()
    .then(m => { isMaximized.value = m })
    .catch(() => { /* 启动早期 IPC 偶发不可用时回退到默认 false */ })
})

onUnmounted(() => {
  cleanupMaximizeListener?.()
})

function onMinimize() {
  window.electronAPI.window.minimize()
}

function onToggleMaximize() {
  window.electronAPI.window.toggleMaximize()
}

function onClose() {
  window.electronAPI.window.close()
}
</script>

<template>
  <div class="window-controls">
    <button class="wc-btn" :title="$t('windowControls.minimize')" @click="onMinimize">
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button class="wc-btn" :title="isMaximized ? $t('windowControls.restore') : $t('windowControls.maximize')" @click="onToggleMaximize">
      <!-- 最大化：单个方框 -->
      <svg v-if="!isMaximized" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" stroke-width="1" />
      </svg>
      <!-- 还原：两个交错的小方框（Win11 标准 restore 图标） -->
      <svg v-else viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <rect x="2.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none" stroke-width="1" />
        <path d="M 0.5 9.5 L 0.5 2.5 L 7.5 2.5" stroke="currentColor" fill="none" stroke-width="1" />
        <path d="M 0.5 9.5 L 7.5 9.5 L 7.5 2.5" stroke="currentColor" fill="none" stroke-width="1" />
      </svg>
    </button>
    <button class="wc-btn wc-btn-close" :title="$t('windowControls.close')" @click="onClose">
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1" />
        <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  /* 铺满所在顶条，三按钮贴到窗口上沿，与 Win11 原生标题栏一致 */
  align-self: stretch;
  height: auto;
  /* 三按钮区不参与窗口拖动，避免 header 的 drag 区把点击吃掉 */
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  /* 主区顶条的 gap 已提供与前一个按钮的间距；顶条在 Windows 下 padding-right 特化为 0，让按钮贴右边。 */
}

.wc-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  transition: background-color 0.1s ease;
  -webkit-app-region: no-drag;
  /* 防止快速双击连点时把 SVG 选中（Win11 原生按钮也不允许选中） */
  user-select: none;
  -webkit-user-select: none;
}

.wc-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.wc-btn:active {
  background: rgba(255, 255, 255, 0.04);
}

/* 浅色主题下 hover 用半透明黑（白色 hover 在浅底上看不清） */
[data-color-scheme="light"] .wc-btn:hover {
  background: rgba(0, 0, 0, 0.06);
}
[data-color-scheme="light"] .wc-btn:active {
  background: rgba(0, 0, 0, 0.03);
}

/* 关闭按钮 hover：标准 Win11 红 */
.wc-btn-close:hover {
  background: #c42b1c;
  color: #ffffff;
}
.wc-btn-close:active {
  background: #b01a0e;
  color: #ffffff;
}
</style>
