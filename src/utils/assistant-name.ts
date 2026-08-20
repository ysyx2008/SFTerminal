/**
 * 助手的名字：用户给它起了名就用用户起的，没起就用应用名。
 * 只在这里解析一次——侧栏、产出物提示等都从这儿取，免得各处各写一套兜底。
 */
import i18n from '../i18n'
import { useConfigStore } from '../stores/config'

export function resolveAssistantName(): string {
  const configStore = useConfigStore()
  const custom = configStore.agentName?.trim()
  if (custom) return custom
  const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__
  if (isSteamBuild) {
    // Steam 版用独立品牌名
    return (configStore.language || 'zh-CN').startsWith('zh') ? '旗鱼终端' : 'SFTerm'
  }
  return i18n.global.t('app.title')
}
