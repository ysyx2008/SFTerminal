/**
 * 技能目录数据加载与状态管理。
 *
 * 抽离自 `Settings/SkillSettings.vue`，让「能力档案 Tab」与「设置 → 技能」
 * 子页共享同一份 IPC 调用与数据模型，避免重复实现两套。
 *
 * 该 composable **不持久化任何状态**——每次调用都是独立的 ref 实例，
 * 由使用方按需 onMounted 触发加载。toggle / install / uninstall 等操作会
 * 就地更新 ref，调用方需自行处理副作用（如重新渲染）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

export interface BuiltinSkill {
  id: string
  name: string
  description: string
  enabled: boolean
}

export interface UserSkill {
  id: string
  name: string
  description: string
  version?: string
  enabled: boolean
  content: string
  filePath: string
  lastModified: number
  source?: 'sailfish' | 'clawhub'
  author?: string
  permissions?: string[]
  requires?: { env?: string[]; bins?: string[] }
}

export interface SkillEnvStatus {
  name: string
  configured: boolean
}

export interface MarketSkillItem {
  id: string
  name: string
  description: string
  version: string
  author: string
  source?: 'sailfish' | 'clawhub'
  category?: string
  tags?: string[]
  featured?: boolean
  permissions?: string[]
  installed: boolean
  installedVersion?: string
  hasUpdate: boolean
}

export interface SkillCategory {
  id: string
  name: string
  nameEn: string
  icon: string
}

export function useSkillCatalog() {
  const { t, te, locale } = useI18n()

  // 内置技能
  const builtinSkills = ref<BuiltinSkill[]>([])
  // 用户扩展技能
  const skills = ref<UserSkill[]>([])
  const loading = ref(false)
  const skillsDir = ref('')

  // 技能市场
  const marketSkills = ref<MarketSkillItem[]>([])
  const categories = ref<SkillCategory[]>([])
  const marketLoading = ref(false)
  const marketError = ref('')

  // env key 配置状态（按 skillId 索引）
  const envStatuses = ref<Record<string, SkillEnvStatus[]>>({})
  /**
   * env 输入框值。key 形如 `${skillId}:${envName}`，**不能只用 envName**——
   * 多个技能可能要求同名 env 变量（如 STOCK_API_KEY），单用 envName 会让两个技能的
   * 输入框共享同一个值，导致串改。
   */
  const envInputValues = ref<Record<string, string>>({})
  const envSaving = ref<Set<string>>(new Set())

  /** 已启用的技能总数（内置 + 扩展） */
  const enabledCount = computed(() =>
    builtinSkills.value.filter(s => s.enabled).length +
    skills.value.filter(s => s.enabled).length
  )

  /** 当前语言下的内置技能本地化名称 */
  function localizedBuiltinSkillName(skill: BuiltinSkill): string {
    const key = `skillSettings.builtinSkillNames.${skill.id}`
    return te(key) ? String(t(key)) : skill.name
  }

  /** 当前语言下的内置技能本地化描述 */
  function localizedBuiltinSkillDesc(skill: BuiltinSkill): string {
    const key = `skillSettings.builtinSkillDescs.${skill.id}`
    return te(key) ? String(t(key)) : skill.description
  }

  // ===== 内置技能 =====

  async function loadBuiltinSkills() {
    try {
      builtinSkills.value = await window.electronAPI.builtinSkill.list()
    } catch (error) {
      console.error('Failed to load builtin skills:', error)
    }
  }

  async function toggleBuiltinSkill(skill: BuiltinSkill) {
    const newEnabled = !skill.enabled
    try {
      const success = await window.electronAPI.builtinSkill.toggle(skill.id, newEnabled)
      if (success) {
        skill.enabled = newEnabled
      }
    } catch (error) {
      console.error('Failed to toggle builtin skill:', error)
    }
  }

  // ===== 用户扩展技能 =====

  async function loadSkills() {
    loading.value = true
    try {
      skills.value = await window.electronAPI.userSkill.list()
      skillsDir.value = await window.electronAPI.userSkill.getSkillsDir()
      await loadAllEnvStatuses()
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      loading.value = false
    }
  }

  async function refreshSkills() {
    loading.value = true
    try {
      skills.value = await window.electronAPI.userSkill.refresh()
    } catch (error) {
      console.error('Failed to refresh skills:', error)
    } finally {
      loading.value = false
    }
  }

  async function toggleSkill(skill: UserSkill) {
    const newEnabled = !skill.enabled
    const success = await window.electronAPI.userSkill.toggle(skill.id, newEnabled)
    if (success) {
      skill.enabled = newEnabled
    }
  }

  async function openFolder() {
    await window.electronAPI.userSkill.openFolder()
  }

  async function getSkillContent(skillId: string): Promise<string | null> {
    try {
      return await window.electronAPI.userSkill.getContent(skillId)
    } catch {
      return null
    }
  }

  // ===== env key 管理 =====

  async function loadEnvStatus(skillId: string) {
    try {
      const statuses = await window.electronAPI.userSkill.getEnvStatus(skillId)
      envStatuses.value[skillId] = statuses
    } catch (e) {
      console.error('Failed to load env status:', e)
    }
  }

  async function loadAllEnvStatuses() {
    for (const skill of skills.value) {
      if (skill.requires?.env?.length) {
        await loadEnvStatus(skill.id)
      }
    }
  }

  async function saveEnv(skillId: string, envName: string) {
    const inputKey = `${skillId}:${envName}`
    const value = envInputValues.value[inputKey]
    if (!value?.trim()) return
    envSaving.value.add(inputKey)
    try {
      await window.electronAPI.userSkill.setEnv(skillId, envName, value.trim())
      envInputValues.value[inputKey] = ''
      await loadEnvStatus(skillId)
    } finally {
      envSaving.value.delete(inputKey)
    }
  }

  async function deleteEnv(skillId: string, envName: string) {
    await window.electronAPI.userSkill.deleteEnv(skillId, envName)
    await loadEnvStatus(skillId)
  }

  // ===== 技能市场 =====

  async function loadMarketSkills(force = false) {
    marketLoading.value = true
    marketError.value = ''
    try {
      marketSkills.value = await window.electronAPI.skillMarket.list(force)
      const registry = await window.electronAPI.skillMarket.fetchRegistry(force)
      if (registry.categories) {
        categories.value = registry.categories
      }
    } catch (error: any) {
      marketError.value = error.message || 'Unknown error'
      console.error('Failed to load market:', error)
    } finally {
      marketLoading.value = false
    }
  }

  async function installSkill(skill: MarketSkillItem) {
    const result = await window.electronAPI.skillMarket.install(skill.id)
    if (result.success) {
      skill.installed = true
      skill.installedVersion = skill.version
      skill.hasUpdate = false
      await loadSkills()
    }
    return result
  }

  async function uninstallSkill(skill: MarketSkillItem | UserSkill) {
    const result = await window.electronAPI.skillMarket.uninstall(skill.id)
    if (result.success) {
      if ('installed' in skill) {
        skill.installed = false
        skill.installedVersion = undefined
        skill.hasUpdate = false
      }
      // 同步市场列表里同名技能的 installed 状态——从「我的技能」卸载时，
      // 市场视图里同一 id 的卡片也应回到「未安装」，避免视图间状态不一致。
      const marketMatch = marketSkills.value.find(m => m.id === skill.id)
      if (marketMatch) {
        marketMatch.installed = false
        marketMatch.installedVersion = undefined
        marketMatch.hasUpdate = false
      }
      await loadSkills()
    }
    return result
  }

  async function updateSkill(skill: MarketSkillItem) {
    const result = await window.electronAPI.skillMarket.update(skill.id)
    if (result.success) {
      skill.installedVersion = skill.version
      skill.hasUpdate = false
      await loadSkills()
    }
    return result
  }

  function categoryLabel(cat: SkillCategory): string {
    return locale.value.startsWith('zh') ? cat.name : cat.nameEn
  }

  return {
    // state
    builtinSkills,
    skills,
    loading,
    skillsDir,
    marketSkills,
    categories,
    marketLoading,
    marketError,
    envStatuses,
    envInputValues,
    envSaving,
    // computed
    enabledCount,
    // actions
    loadBuiltinSkills,
    loadSkills,
    refreshSkills,
    loadMarketSkills,
    loadAllEnvStatuses,
    toggleBuiltinSkill,
    toggleSkill,
    openFolder,
    getSkillContent,
    loadEnvStatus,
    saveEnv,
    deleteEnv,
    installSkill,
    uninstallSkill,
    updateSkill,
    // helpers
    localizedBuiltinSkillName,
    localizedBuiltinSkillDesc,
    categoryLabel,
  }
}

export type UseSkillCatalogReturn = ReturnType<typeof useSkillCatalog>
