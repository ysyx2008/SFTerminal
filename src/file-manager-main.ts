import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import FileManagerApp from './views/FileManagerView.vue'
import { useConfigStore } from './stores/config'
import i18n from './i18n'
import { setLocale } from './i18n'
import './styles/main.css'

const app = createApp(FileManagerApp)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)

const configStore = useConfigStore()

// 挂载前先把 UI 主题同步到 <html> 和 store，消除"启动蓝色一闪而过"的 FOUC：
// - file-manager.html 的内联脚本已处理有 localStorage 缓存的场景
// - 这里兜"首次启动、localStorage 还没缓存"的场景
async function preloadUiTheme(): Promise<void> {
  try {
    const theme = await window.electronAPI?.config?.getUiTheme?.()
    if (!theme) return
    document.documentElement.setAttribute('data-ui-theme', theme)
    configStore.uiTheme = theme
  } catch { /* 主进程不可用时静默降级 */ }
}

preloadUiTheme().finally(() => {
  app.mount('#app')
  void initConfig()
})

// 加载全部配置并同步主题和语言
const initConfig = async () => {
  await configStore.loadConfig()

  document.body.setAttribute('data-ui-theme', configStore.uiTheme)

  setLocale(configStore.language)
  document.title = i18n.global.t('fileManager.windowTitle')

  configStore.$subscribe((_mutation, state) => {
    document.body.setAttribute('data-ui-theme', state.uiTheme)
  })

  watch(() => configStore.language, (newLang) => {
    setLocale(newLang)
    document.title = i18n.global.t('fileManager.windowTitle')
  })
}
