import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import i18n from './i18n'
import { oemConfig } from './config/oem.config'
import { useConfigStore } from './stores/config'
import './styles/main.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)

// FOUC 防护：index.html 内联脚本已经从 localStorage 同步了 data-ui-theme，
// 首次启动（localStorage 没缓存）的场景由 :root 兜底色处理（dark #181818），
// 不需要在 mount 前阻塞拉主进程主题——之前这里 await 了一次 IPC 才 mount，
// 把 Vue 挂载推迟到 ready-to-show 之后 ~200ms，启动期间可见一段 dark blank。
//
// 现在：先 mount，立即通知主进程显示窗口；主题在 mount 后异步对齐。
app.mount('#app')

// 通知主进程：Vue 已挂载，可以 show 主窗口（避免主进程在 ready-to-show 时
// 就 show 出"还没渲染 UI 的黑屏窗口"）。fire-and-forget，主进程有兜底超时。
window.electronAPI?.app?.notifyMounted?.()

// 异步对齐 UI 主题：覆盖"首次启动、localStorage 还没缓存"场景。
// mount 之后跑，不阻塞首帧；如果跟 localStorage 缓存值一致则无视觉变化，
// 不一致时是已显示界面上的一次主题切换，比启动黑屏好得多。
;(async () => {
  try {
    const theme = await window.electronAPI?.config?.getUiTheme?.()
    if (!theme) return
    if (document.documentElement.getAttribute('data-ui-theme') === theme) return
    document.documentElement.setAttribute('data-ui-theme', theme)
    const configStore = useConfigStore()
    configStore.uiTheme = theme
  } catch { /* 主进程不可用时静默降级，由 store 默认值兜底 */ }
})()

window.electronAPI?.app.getVersion().then((version: string) => {
  const displayVersion = oemConfig.brand.version || version
  const brandName = oemConfig.brand.name.zh
  document.title = `${brandName} v${displayVersion}`
})
