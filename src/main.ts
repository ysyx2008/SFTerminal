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

// 挂载前先把 UI 主题同步到 <html> 和 store，消除"启动蓝色一闪而过"的 FOUC：
// - index.html 的内联脚本已处理有 localStorage 缓存的场景
// - 这里覆盖"首次启动、localStorage 还没缓存"的场景：异步从主进程拉一次真实值，
//   然后再 mount，保证 Vue 首帧就用正确的 data-ui-theme
async function preloadUiTheme(): Promise<void> {
  try {
    const theme = await window.electronAPI?.config?.getUiTheme?.()
    if (!theme) return
    document.documentElement.setAttribute('data-ui-theme', theme)
    const configStore = useConfigStore()
    configStore.uiTheme = theme
  } catch { /* 主进程不可用时静默降级，由 store 默认值兜底 */ }
}

preloadUiTheme().finally(() => {
  app.mount('#app')
})

window.electronAPI?.app.getVersion().then((version: string) => {
  const displayVersion = oemConfig.brand.version || version
  const brandName = oemConfig.brand.name.zh
  document.title = `${brandName} v${displayVersion}`
})
