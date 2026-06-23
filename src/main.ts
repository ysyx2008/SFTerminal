import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import i18n from './i18n'
import { getBrandName } from '@shared/brand'
import { oemConfig } from './config/oem.config'
import './styles/main.css'
import './styles/markdown-content.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)

// FOUC 防护：index.html 内联脚本已经从 localStorage 同步了 data-ui-theme，
// 首次启动（localStorage 没缓存）的场景由 :root 兜底色处理（dark #181818），
// 不需要在 mount 前阻塞拉主进程主题。
//
// 主题对齐：configStore 内部会在创建时启动 IIFE 异步从主进程拉真值并对齐
// 内部状态，App.vue 通过 effectiveUiTheme 的 watch immediate 会自动同步到 DOM。
app.mount('#app')

// 通知主进程：Vue 已挂载，可以 show 主窗口（避免主进程在 ready-to-show 时
// 就 show 出"还没渲染 UI 的黑屏窗口"）。fire-and-forget，主进程有兜底超时。
window.electronAPI?.app?.notifyMounted?.()

window.electronAPI?.app.getVersion().then((version: string) => {
  const displayVersion = oemConfig.brand.version || version
  document.title = `${getBrandName('zh-CN')} v${displayVersion}`
})
