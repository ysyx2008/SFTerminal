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

// 挂载前先把 UI 主题同步到 <html>，消除 FOUC：
// - file-manager.html 的内联脚本已处理有 localStorage 缓存的场景
// - configStore 创建时启动的 bootstrap IIFE 会异步把磁盘真值同步到内部状态
// - 这里只用当前 store 的 effectiveUiTheme 立即写一次 DOM，并订阅后续变化
document.documentElement.setAttribute('data-ui-theme', configStore.effectiveUiTheme)

app.mount('#app')
void initConfig()

// 加载全部配置并同步主题和语言
async function initConfig(): Promise<void> {
  await configStore.loadConfig()

  document.body.setAttribute('data-ui-theme', configStore.effectiveUiTheme)

  setLocale(configStore.language)
  document.title = i18n.global.t('fileManager.windowTitle')

  // 订阅生效主题变化（uiTheme 切换、mode 切换、系统外观切换都会触发）
  watch(() => configStore.effectiveUiTheme, (theme) => {
    document.documentElement.setAttribute('data-ui-theme', theme)
    document.body.setAttribute('data-ui-theme', theme)
  })

  watch(() => configStore.language, (newLang) => {
    setLocale(newLang)
    document.title = i18n.global.t('fileManager.windowTitle')
  })
}
