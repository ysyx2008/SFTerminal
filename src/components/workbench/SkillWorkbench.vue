<script setup lang="ts">
/**
 * SkillWorkbench —— 技能（能力档案）工作台
 *
 * 定位：让「秘书会什么」成为可见的身份属性——一眼看到秘书当前具备的能力、
 * 哪些是开着的、状态如何。区别于「设置 → 技能」（重配置管理），这里重「档案呈现」。
 *
 * 与 companion / assistant 工作台平级（kind='skill'），契约见 src/workbench/skill/SPEC.md。
 * 统一渲染器 props 约定：{ tab, isActive }。
 *
 * 该 tab 不对应后端 Agent 实例、无会话/历史——纯前端视图，所有数据来自
 * `useSkillCatalog` composable 的 IPC 调用（builtinSkill / userSkill / skillMarket）。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  RefreshCw, FolderOpen, Eye, X, Download, Trash2, ArrowUpCircle,
  Search, Star, Boxes, Puzzle, Sparkles, AlertCircle
} from 'lucide-vue-next'
import type { TerminalTab } from '../../stores/terminal'
import { useConfigStore } from '../../stores/config'
import { useSkillCatalog, type UserSkill, type MarketSkillItem } from '../../composables/useSkillCatalog'

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

const { t } = useI18n()
const configStore = useConfigStore()
const catalog = useSkillCatalog()

/**
 * Agent 显示名：用户自定义了就用自定义名，否则走 i18n 默认「助手」。
 * 与 `terminal.ts` 中 `configStore.agentName || t('tabs.assistant', '助手')` 同口径。
 * 用于 header subtitle 拼接，避免硬编码"秘书"二字。
 */
const agentDisplayName = computed(() => configStore.agentName || t('tabs.assistant', '助手'))

/** header 副标题："<Agent名>当前掌握的本事" —— 与 Agent 名联动，不写死"秘书" */
const headerSubtitle = computed(() => `${agentDisplayName.value}${t('skillTab.subtitle')}`)

// 子视图：profile（能力档案） / market（技能市场）
type SubView = 'profile' | 'market'
const activeSubView = ref<SubView>('profile')

// 搜索 / 分类（市场视图）
const searchQuery = ref('')
const activeCategory = ref('all')

// 详情弹窗
const showDetail = ref(false)
const detailSkill = ref<MarketSkillItem | null>(null)
const detailContent = ref('')
const detailLoading = ref(false)

// 预览弹窗（我的技能源码）
const showPreview = ref(false)
const previewSkill = ref<UserSkill | null>(null)
const previewContent = ref('')

const operatingSkills = ref<Set<string>>(new Set())

const filteredMarketSkills = computed(() => {
  let list = catalog.marketSkills.value
  if (activeCategory.value !== 'all') {
    list = list.filter(s => s.category === activeCategory.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.tags?.some(tag => tag.toLowerCase().includes(q))
    )
  }
  return list
})

const builtinEnabledCount = computed(() =>
  catalog.builtinSkills.value.filter(s => s.enabled).length
)
const extensionEnabledCount = computed(() =>
  catalog.skills.value.filter(s => s.enabled).length
)
const installedMarketCount = computed(() =>
  catalog.marketSkills.value.filter(s => s.installed).length
)

function categoryCount(catId: string): number {
  return catalog.marketSkills.value.filter(s => s.category === catId).length
}

async function viewSkill(skill: UserSkill) {
  previewSkill.value = skill
  const content = await catalog.getSkillContent(skill.id)
  previewContent.value = content || skill.content
  showPreview.value = true
}

function closePreview() {
  showPreview.value = false
  previewSkill.value = null
  previewContent.value = ''
}

async function viewMarketSkill(skill: MarketSkillItem) {
  detailSkill.value = skill
  detailContent.value = ''
  detailLoading.value = true
  showDetail.value = true

  if (skill.installed) {
    const content = await catalog.getSkillContent(skill.id)
    if (content) {
      detailContent.value = content
      detailLoading.value = false
      return
    }
  }
  detailLoading.value = false
}

function closeDetail() {
  showDetail.value = false
  detailSkill.value = null
  detailContent.value = ''
}

async function handleInstall(skill: MarketSkillItem) {
  operatingSkills.value.add(skill.id)
  try {
    const result = await catalog.installSkill(skill)
    if (!result.success) {
      alert(`${t('skillSettings.installFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.installFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

async function handleUninstall(skill: MarketSkillItem | UserSkill) {
  if (!confirm(`${t('skillSettings.uninstall')} "${skill.name}"?`)) return
  operatingSkills.value.add(skill.id)
  try {
    const result = await catalog.uninstallSkill(skill)
    if (!result.success) {
      alert(`${t('skillSettings.uninstallFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.uninstallFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

async function handleUpdate(skill: MarketSkillItem) {
  operatingSkills.value.add(skill.id)
  try {
    const result = await catalog.updateSkill(skill)
    if (!result.success) {
      alert(`${t('skillSettings.updateFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.updateFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

function switchToMarket() {
  activeSubView.value = 'market'
  if (catalog.marketSkills.value.length === 0 && !catalog.marketLoading.value) {
    catalog.loadMarketSkills()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showDetail.value) {
      e.stopImmediatePropagation()
      closeDetail()
    } else if (showPreview.value) {
      e.stopImmediatePropagation()
      closePreview()
    }
  }
}

// 切换到该 tab 时加载；首次激活前不发起 IPC，避免无谓开销
watch(() => props.isActive, (active) => {
  if (active) {
    void loadAll()
  }
}, { immediate: true })

// 切换到市场子视图时按需加载
watch(activeSubView, (view) => {
  if (view === 'market' && catalog.marketSkills.value.length === 0 && !catalog.marketLoading.value) {
    catalog.loadMarketSkills()
  }
})

async function loadAll() {
  await Promise.all([
    catalog.loadBuiltinSkills(),
    catalog.loadSkills(),
  ])
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
  // 即使非激活也加载一次（用户切过来时立即可见）
  if (props.isActive) {
    void loadAll()
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <div class="skill-workbench">
    <!-- 顶部：标题 + 能力概览 + 视图切换 -->
    <header class="sw-header">
      <div class="sw-header-left">
        <div class="sw-header-title">
          <Boxes :size="20" />
          <h2>{{ t('skillTab.title') }}</h2>
        </div>
        <p class="sw-header-sub">{{ headerSubtitle }}</p>
      </div>
      <div class="sw-stats">
        <div class="sw-stat">
          <span class="sw-stat-num">{{ builtinEnabledCount }}</span>
          <span class="sw-stat-label">{{ t('skillTab.builtinEnabled') }}</span>
        </div>
        <div class="sw-stat">
          <span class="sw-stat-num">{{ extensionEnabledCount }}</span>
          <span class="sw-stat-label">{{ t('skillTab.extensionEnabled') }}</span>
        </div>
      </div>
      <div class="sw-sub-tabs">
        <button
          class="sw-sub-tab"
          :class="{ active: activeSubView === 'profile' }"
          @click="activeSubView = 'profile'"
        >
          <Sparkles :size="14" />
          <span>{{ t('skillTab.profile') }}</span>
        </button>
        <button
          class="sw-sub-tab"
          :class="{ active: activeSubView === 'market' }"
          @click="switchToMarket()"
        >
          <Puzzle :size="14" />
          <span>{{ t('skillTab.market') }}</span>
          <span v-if="installedMarketCount > 0" class="sw-tab-badge">{{ installedMarketCount }}</span>
        </button>
      </div>
    </header>

    <!-- ========== 能力档案视图 ========== -->
    <section v-if="activeSubView === 'profile'" class="sw-body sw-profile">
      <!-- 内置能力 -->
      <div class="sw-section">
        <div class="sw-section-header">
          <h3>{{ t('skillSettings.builtinSkills') }}</h3>
          <span class="sw-section-hint">{{ t('skillTab.builtinHint') }}</span>
        </div>
        <div class="sw-card-grid">
          <div
            v-for="skill in catalog.builtinSkills.value"
            :key="'builtin-' + skill.id"
            class="sw-card"
            :class="{ disabled: !skill.enabled }"
          >
            <div class="sw-card-toggle">
              <label class="sw-switch">
                <input
                  type="checkbox"
                  :checked="skill.enabled"
                  @change="catalog.toggleBuiltinSkill(skill)"
                />
                <span class="sw-switch-slider"></span>
              </label>
            </div>
            <div class="sw-card-body">
              <div class="sw-card-name">{{ catalog.localizedBuiltinSkillName(skill) }}</div>
              <div class="sw-card-desc" :title="catalog.localizedBuiltinSkillDesc(skill)">
                {{ catalog.localizedBuiltinSkillDesc(skill) }}
              </div>
            </div>
            <div class="sw-card-status" :class="{ on: skill.enabled }">
              {{ skill.enabled ? t('skillSettings.enabled') : t('skillTab.disabled') }}
            </div>
          </div>
        </div>
      </div>

      <!-- 扩展能力 -->
      <div class="sw-section">
        <div class="sw-section-header">
          <h3>{{ t('skillSettings.extensionSkills') }}</h3>
          <div class="sw-section-actions">
            <button
              class="sw-btn-icon"
              @click="catalog.refreshSkills()"
              :disabled="catalog.loading.value"
              :title="t('skillSettings.refresh')"
            >
              <RefreshCw :size="14" :class="{ spinning: catalog.loading.value }" />
            </button>
            <button class="sw-btn sw-btn-primary sw-btn-sm" @click="catalog.openFolder()">
              <FolderOpen :size="14" />
              {{ t('skillSettings.openFolder') }}
            </button>
          </div>
        </div>
        <p class="sw-section-desc">{{ t('skillSettings.extensionSkillsDesc') }}</p>

        <div v-if="catalog.skills.value.length === 0 && !catalog.loading.value" class="sw-empty">
          <Boxes :size="36" />
          <p>{{ t('skillSettings.noSkills') }}</p>
          <p class="sw-empty-tip">{{ t('skillSettings.noSkillsTip') }}</p>
        </div>

        <div class="sw-card-grid">
          <div
            v-for="skill in catalog.skills.value"
            :key="skill.id"
            class="sw-card"
            :class="{ disabled: !skill.enabled }"
          >
            <div class="sw-card-toggle">
              <label class="sw-switch">
                <input
                  type="checkbox"
                  :checked="skill.enabled"
                  @change="catalog.toggleSkill(skill)"
                />
                <span class="sw-switch-slider"></span>
              </label>
            </div>
            <div class="sw-card-body">
              <div class="sw-card-name">
                {{ skill.name }}
                <span v-if="skill.version" class="sw-version">v{{ skill.version }}</span>
                <span v-if="skill.source === 'clawhub'" class="sw-source-badge">ClawHub</span>
              </div>
              <div class="sw-card-desc" :title="skill.description">{{ skill.description }}</div>
              <!-- env key 内联行 -->
              <div v-if="skill.requires?.env?.length" class="sw-env-inline">
                <div
                  v-for="envStatus in (catalog.envStatuses.value[skill.id] ?? skill.requires?.env?.map(n => ({ name: n, configured: false })) ?? [])"
                  :key="envStatus.name"
                  class="sw-env-row"
                >
                  <span class="sw-env-key">{{ envStatus.name }}</span>
                  <template v-if="envStatus.configured">
                    <span class="sw-env-dot ok" :title="t('skillSettings.keyConfigured')">●</span>
                    <button
                      class="sw-env-reset"
                      @click.stop="catalog.deleteEnv(skill.id, envStatus.name)"
                    >{{ t('skillSettings.keyReset') }}</button>
                  </template>
                  <template v-else>
                    <input
                      :placeholder="t('skillSettings.keyPlaceholder')"
                      class="sw-env-input"
                      type="password"
                      v-model="catalog.envInputValues.value[`${skill.id}:${envStatus.name}`]"
                      @keyup.enter="catalog.saveEnv(skill.id, envStatus.name)"
                      @click.stop
                    />
                    <button
                      class="sw-btn sw-btn-primary sw-btn-xs"
                      :disabled="!catalog.envInputValues.value[`${skill.id}:${envStatus.name}`]?.trim() || catalog.envSaving.value.has(`${skill.id}:${envStatus.name}`)"
                      @click.stop="catalog.saveEnv(skill.id, envStatus.name)"
                    >{{ t('skillSettings.keySave') }}</button>
                  </template>
                </div>
              </div>
            </div>
            <div class="sw-card-actions">
              <button class="sw-btn-icon" @click="viewSkill(skill)" :title="t('skillSettings.view')">
                <Eye :size="14" />
              </button>
              <button
                class="sw-btn-icon sw-btn-danger-ghost"
                @click.stop="handleUninstall(skill)"
                :title="t('skillSettings.uninstall')"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ========== 技能市场视图 ========== -->
    <section v-else class="sw-body sw-market">
      <div class="sw-market-toolbar">
        <div class="sw-search">
          <Search :size="14" />
          <input
            v-model="searchQuery"
            :placeholder="t('skillSettings.searchPlaceholder')"
            class="sw-search-input"
          />
        </div>
        <div class="sw-categories">
          <button
            class="sw-cat-btn"
            :class="{ active: activeCategory === 'all' }"
            @click="activeCategory = 'all'"
          >
            {{ t('skillSettings.allCategories') }}
          </button>
          <button
            v-for="cat in catalog.categories.value"
            :key="cat.id"
            class="sw-cat-btn"
            :class="{ active: activeCategory === cat.id }"
            @click="activeCategory = cat.id"
          >
            {{ catalog.categoryLabel(cat) }}
            <span class="sw-cat-count">{{ categoryCount(cat.id) }}</span>
          </button>
        </div>
      </div>

      <div v-if="catalog.marketLoading.value" class="sw-loading">
        <RefreshCw class="spinning" :size="20" />
        <span>{{ t('skillSettings.marketLoading') }}</span>
      </div>

      <div v-else-if="catalog.marketError.value" class="sw-error">
        <AlertCircle :size="20" />
        <span>{{ catalog.marketError.value }}</span>
        <button class="sw-btn sw-btn-sm" @click="catalog.loadMarketSkills(true)">
          {{ t('skillSettings.marketRetry') }}
        </button>
      </div>

      <div v-else-if="filteredMarketSkills.length === 0" class="sw-empty">
        <Boxes :size="36" />
        <p>{{ t('skillSettings.marketEmpty') }}</p>
        <p class="sw-empty-tip">{{ t('skillSettings.marketEmptyTip') }}</p>
      </div>

      <div v-else class="sw-card-grid">
        <div
          v-for="skill in filteredMarketSkills"
          :key="skill.id"
          class="sw-card sw-market-card"
          :class="{ installed: skill.installed }"
        >
          <div class="sw-card-body">
            <div class="sw-card-name">
              {{ skill.name }}
              <span v-if="skill.featured" class="sw-featured-badge">
                <Star :size="10" fill="currentColor" />
              </span>
            </div>
            <div class="sw-card-desc">{{ skill.description }}</div>
            <div class="sw-card-meta">
              <span v-if="skill.author" class="sw-meta">{{ t('skillSettings.by') }} {{ skill.author }}</span>
              <span v-if="skill.installedVersion" class="sw-meta">v{{ skill.installedVersion }}</span>
            </div>
          </div>
          <div class="sw-card-actions">
            <button
              v-if="!skill.installed"
              class="sw-btn sw-btn-primary sw-btn-sm"
              :disabled="operatingSkills.has(skill.id)"
              @click="handleInstall(skill)"
            >
              <Download :size="14" />
              {{ t('skillSettings.install') }}
            </button>
            <template v-else>
              <button
                v-if="skill.hasUpdate"
                class="sw-btn sw-btn-sm"
                :disabled="operatingSkills.has(skill.id)"
                @click="handleUpdate(skill)"
              >
                <ArrowUpCircle :size="14" />
                {{ t('skillSettings.updateBtn') }}
              </button>
              <button
                class="sw-btn-icon sw-btn-danger-ghost"
                :disabled="operatingSkills.has(skill.id)"
                @click.stop="handleUninstall(skill)"
                :title="t('skillSettings.uninstall')"
              >
                <Trash2 :size="14" />
              </button>
            </template>
            <button class="sw-btn-icon" @click="viewMarketSkill(skill)" :title="t('skillSettings.view')">
              <Eye :size="14" />
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 我的技能源码预览弹窗 -->
    <Teleport to="body">
      <div v-if="showPreview" class="sw-modal-overlay" @click.self="closePreview">
        <div class="sw-modal">
          <div class="sw-modal-header">
            <h3>{{ previewSkill?.name }}</h3>
            <button class="sw-modal-close" @click="closePreview"><X :size="16" /></button>
          </div>
          <pre class="sw-modal-body">{{ previewContent }}</pre>
        </div>
      </div>
    </Teleport>

    <!-- 市场技能详情弹窗 -->
    <Teleport to="body">
      <div v-if="showDetail" class="sw-modal-overlay" @click.self="closeDetail">
        <div class="sw-modal">
          <div class="sw-modal-header">
            <h3>{{ detailSkill?.name }}</h3>
            <button class="sw-modal-close" @click="closeDetail"><X :size="16" /></button>
          </div>
          <div class="sw-modal-body">
            <div v-if="detailLoading" class="sw-loading">{{ t('skillSettings.skillDetailLoading') }}</div>
            <pre v-else>{{ detailContent || t('skillSettings.skillDetailNotInstalled') }}</pre>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.skill-workbench {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  overflow: hidden;
}

/* ===== Header ===== */
.sw-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.sw-header-left { flex: 1; min-width: 0; }
.sw-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}
.sw-header-title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.sw-header-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.sw-stats {
  display: flex;
  gap: 20px;
}
.sw-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.sw-stat-num {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent-primary);
}
.sw-stat-label {
  font-size: 11px;
  color: var(--text-muted);
}
.sw-sub-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}
.sw-sub-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sw-sub-tab:hover { color: var(--text-primary); }
.sw-sub-tab.active {
  background: var(--bg-primary);
  color: var(--accent-primary);
  font-weight: 600;
}
.sw-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent-primary);
  color: white;
  font-size: 10px;
  font-weight: 600;
}

/* ===== Body ===== */
.sw-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 0;
}
.sw-section { margin-bottom: 24px; }
.sw-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sw-section-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.sw-section-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.sw-section-desc {
  margin: 4px 0 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.sw-section-actions {
  display: flex;
  gap: 6px;
}

/* ===== Card Grid ===== */
.sw-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.sw-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}
.sw-card:hover {
  border-color: var(--accent-primary);
  background: var(--bg-hover);
}
.sw-card.disabled {
  opacity: 0.55;
}
.sw-card-toggle {
  flex-shrink: 0;
  padding-top: 2px;
}
.sw-card-body {
  flex: 1;
  min-width: 0;
}
.sw-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sw-card-desc {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sw-card-meta {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.sw-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.sw-version {
  font-size: 10px;
  color: var(--text-muted);
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
}
.sw-source-badge,
.sw-featured-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}
.sw-source-badge {
  background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
  color: var(--accent-primary);
}
.sw-featured-badge {
  display: inline-flex;
  align-items: center;
  background: color-mix(in srgb, var(--color-warning) 30%, transparent);
  color: var(--color-warning);
}
.sw-card-status {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.sw-card-status.on {
  background: color-mix(in srgb, var(--color-success, #10b981) 20%, transparent);
  color: var(--color-success, #10b981);
}
.sw-card-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* ===== Switch ===== */
.sw-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  cursor: pointer;
}
.sw-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.sw-switch-slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary);
  border-radius: 18px;
  transition: 0.2s;
}
.sw-switch-slider::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  left: 2px;
  top: 2px;
  background: var(--text-muted);
  border-radius: 50%;
  transition: 0.2s;
}
.sw-switch input:checked + .sw-switch-slider {
  background: var(--accent-primary);
}
.sw-switch input:checked + .sw-switch-slider::before {
  transform: translateX(14px);
  background: white;
}

/* ===== Buttons ===== */
.sw-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sw-btn:hover { background: var(--bg-hover); }
.sw-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sw-btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}
.sw-btn-primary:hover {
  background: color-mix(in srgb, var(--accent-primary) 85%, white);
}
.sw-btn-sm { padding: 4px 8px; font-size: 11px; }
.sw-btn-xs { padding: 2px 6px; font-size: 11px; }
.sw-btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}
.sw-btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.sw-btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sw-btn-danger-ghost:hover { color: var(--accent-error); }

/* ===== Env inline ===== */
.sw-env-inline {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sw-env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.sw-env-key {
  color: var(--text-secondary);
  min-width: 90px;
}
.sw-env-dot {
  font-size: 10px;
}
.sw-env-dot.ok { color: var(--color-success, #10b981); }
.sw-env-reset {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  text-decoration: underline;
  font-size: 11px;
}
.sw-env-reset:hover { color: var(--accent-error); }
.sw-env-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
}

/* ===== Market toolbar ===== */
.sw-market-toolbar {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sw-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-muted);
}
.sw-search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 13px;
}
.sw-categories {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sw-cat-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sw-cat-btn:hover { color: var(--text-primary); }
.sw-cat-btn.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}
.sw-cat-count {
  font-size: 10px;
  opacity: 0.7;
}

/* ===== States ===== */
.sw-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--text-muted);
  text-align: center;
}
.sw-empty-tip { font-size: 11px; opacity: 0.7; }
.sw-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  padding: 40px;
  color: var(--text-muted);
}
.sw-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px;
  color: var(--accent-error);
}
.spinning {
  animation: sw-spin 1s linear infinite;
}
@keyframes sw-spin {
  to { transform: rotate(360deg); }
}

/* ===== Modal ===== */
.sw-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.sw-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  width: min(720px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
}
.sw-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
.sw-modal-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.sw-modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
}
.sw-modal-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.sw-modal-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== Scrollbar ===== */
.sw-body::-webkit-scrollbar {
  width: 8px;
}
.sw-body::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 4px;
}
.sw-body::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}
</style>
