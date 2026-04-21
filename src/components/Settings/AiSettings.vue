<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X, ExternalLink, Eye } from 'lucide-vue-next'
import { useConfigStore, type AiProfile, type AiModelType, type ApiFormat } from '../../stores/config'
import { AI_TEMPLATES } from '../../config/ai-templates'
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderId } from '@shared/types'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

const configStore = useConfigStore()

const showForm = ref(false)

// ESC 关闭编辑表单
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showForm.value) {
    e.stopImmediatePropagation()
    showForm.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
  initTtsState()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
const debugMode = computed(() => configStore.agentDebugMode)

const openLogDir = () => {
  window.electronAPI.config.openLogDir()
}

const openAiDebugLogDir = async () => {
  const aiDebugLogDir = await window.electronAPI.aiDebugGetLogDir()
  await window.electronAPI.shell.openPath(aiDebugLogDir)
}

const editingProfile = ref<AiProfile | null>(null)

const formData = ref<Partial<AiProfile>>({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  proxy: '',
  contextLength: 128000,
  maxOutputTokens: undefined,
  temperature: undefined,
  modelType: 'general' as AiModelType,
  visionProfileId: undefined,
  apiFormat: 'auto' as ApiFormat
})

const profiles = computed(() => configStore.aiProfiles)
const activeProfileId = computed(() => configStore.activeAiProfileId)

const resetForm = () => {
  formData.value = {
    name: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    proxy: '',
    contextLength: 128000,
    maxOutputTokens: undefined,
    temperature: undefined,
    modelType: 'general' as AiModelType,
    visionProfileId: undefined,
    apiFormat: 'auto' as ApiFormat
  }
  editingProfile.value = null
}

// 可选的视觉模型列表（排除正在编辑的自身）
const visionProfileOptions = computed(() => {
  return profiles.value.filter(p => 
    p.modelType === 'vision' && p.id !== editingProfile.value?.id
  )
})

const contextLengthInK = computed({
  get: () => {
    const v = formData.value.contextLength
    return v ? Math.round(v / 1000) : undefined
  },
  set: (val: number | undefined) => {
    formData.value.contextLength = val ? val * 1000 : undefined
  }
})

const openNewProfile = () => {
  resetForm()
  showForm.value = true
}

const openEditProfile = (profile: AiProfile) => {
  editingProfile.value = profile
  formData.value = { ...profile }
  showForm.value = true
}

const saveProfile = async () => {
  if (!formData.value.name || !formData.value.apiUrl || !formData.value.model) {
    return
  }

  // API Key 未填写时给予提示确认
  if (!formData.value.apiKey) {
    const confirmed = confirm(t('aiSettings.confirmNoApiKey'))
    if (!confirmed) {
      return
    }
  }

  // v-model.number 清空时返回空字符串，需要还原为 undefined
  const data = { ...formData.value }
  if (typeof data.temperature !== 'number' || isNaN(data.temperature)) {
    data.temperature = undefined
  }

  if (editingProfile.value) {
    await configStore.updateAiProfile({
      ...editingProfile.value,
      ...data
    } as AiProfile)
  } else {
    await configStore.addAiProfile({
      id: uuidv4(),
      ...data
    } as AiProfile)
  }

  showForm.value = false
  resetForm()
}

const deleteProfile = async (profile: AiProfile) => {
  if (confirm(t('aiSettings.confirmDeleteProfile'))) {
    await configStore.deleteAiProfile(profile.id)
  }
}

const setActive = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// Steam 版本：不提供任何 AI/API 配置入口，仅展示说明（__STEAM_BUILD__ 由 vite define 注入）
const isSteamBuild = __STEAM_BUILD__

// 非 Steam 版显示全部模板；Steam 版不展示配置 UI，此处仅用于非 Steam
// 模板数据来自 src/config/ai-templates.ts（单一数据源）
const templates = computed(() => AI_TEMPLATES)

const applyTemplate = (template: typeof templates.value[0]) => {
  formData.value.name = template.name
  formData.value.apiUrl = template.apiUrl
  formData.value.model = template.model
}

// 当前选中的模板对应的 keyUrl
const currentKeyUrl = computed(() => {
  const template = templates.value.find(t => t.apiUrl === formData.value.apiUrl)
  return template?.keyUrl || null
})

const openKeyUrl = (url: string) => {
  window.open(url, '_blank')
}

// ==================== TTS 语音合成 ====================

interface TtsPresetVoice { id: string; name: string }
interface TtsPreset {
  id: string
  providerId: string
  name: string
  group: 'international' | 'domestic' | 'other'
  apiUrl: string
  models: string[]
  defaultModel: string
  voices: TtsPresetVoice[]
  defaultVoice: string
  keyUrl: string
  keyPlaceholder: string
  keyLabel?: string
  modelLabel?: string
  modelPlaceholder?: string
}

const ttsPresets: TtsPreset[] = [
  {
    id: 'openai',
    providerId: 'openai-compat',
    name: 'OpenAI',
    group: 'international',
    apiUrl: 'https://api.openai.com/v1/audio/speech',
    models: ['tts-1', 'tts-1-hd'],
    defaultModel: 'tts-1',
    voices: [
      { id: 'alloy', name: 'Alloy' }, { id: 'ash', name: 'Ash' },
      { id: 'ballad', name: 'Ballad' }, { id: 'coral', name: 'Coral' },
      { id: 'echo', name: 'Echo' }, { id: 'fable', name: 'Fable' },
      { id: 'nova', name: 'Nova' }, { id: 'onyx', name: 'Onyx' },
      { id: 'sage', name: 'Sage' }, { id: 'shimmer', name: 'Shimmer' },
    ],
    defaultVoice: 'alloy',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'volcengine',
    providerId: 'volcengine-tts',
    name: t('settings.tts.presets.volcengine'),
    group: 'domestic',
    apiUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    models: [],
    defaultModel: '',
    voices: [
      { id: 'zh_female_cancan_mars_bigtts', name: '灿灿 (Shiny)' },
      { id: 'zh_male_xudong_conversation_wvae_bigtts', name: '快乐小东' },
      { id: 'zh_female_qinqienvsheng_moon_bigtts', name: '亲切女声' },
    ],
    defaultVoice: 'zh_female_cancan_mars_bigtts',
    keyUrl: 'https://console.volcengine.com/speech/app',
    keyPlaceholder: 'Access Token',
    keyLabel: 'Access Token',
    modelLabel: 'App ID',
    modelPlaceholder: t('settings.tts.volcengineAppIdHint'),
  },
  {
    id: 'dashscope',
    providerId: 'dashscope-tts',
    name: t('settings.tts.presets.dashscope'),
    group: 'domestic',
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    models: ['qwen3-tts-flash', 'qwen3-tts-instruct-flash'],
    defaultModel: 'qwen3-tts-flash',
    voices: [
      { id: 'Cherry', name: '芊悦 (Cherry)' }, { id: 'Ethan', name: '晨煦 (Ethan)' },
      { id: 'Nofish', name: '不吃鱼 (Nofish)' }, { id: 'Ryan', name: '甜茶 (Ryan)' },
      { id: 'Katerina', name: '卡捷琳娜 (Katerina)' }, { id: 'Elias', name: '墨讲师 (Elias)' },
    ],
    defaultVoice: 'Cherry',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'custom',
    providerId: 'openai-compat',
    name: t('settings.tts.presets.custom'),
    group: 'other',
    apiUrl: '', models: [], defaultModel: '',
    voices: [], defaultVoice: '',
    keyUrl: '', keyPlaceholder: '',
  },
]

const ttsEnabled = ref(false)
const ttsPresetId = ref('openai')
const ttsApiUrl = ref('')
const ttsApiKey = ref('')
const ttsModel = ref('')
const ttsVoice = ref('')
const ttsSpeed = ref(1.0)
const ttsAutoSpeak = ref(false)
const ttsIsTesting = ref(false)
const ttsTestError = ref('')
const ttsSaved = ref(false)
let ttsInitializing = true

const ttsSelectedPreset = computed(() =>
  ttsPresets.find(p => p.id === ttsPresetId.value) || ttsPresets[ttsPresets.length - 1]
)
const ttsIsCustom = computed(() => ttsPresetId.value === 'custom')
const ttsInternationalPresets = computed(() => ttsPresets.filter(p => p.group === 'international'))
const ttsDomesticPresets = computed(() => ttsPresets.filter(p => p.group === 'domestic'))
const ttsOtherPresets = computed(() => ttsPresets.filter(p => p.group === 'other'))

const ttsDirty = computed(() => {
  const s = configStore.ttsSettings
  return ttsPresetId.value !== (s.preset || 'openai')
    || ttsApiUrl.value !== s.apiUrl
    || ttsApiKey.value !== s.apiKey
    || ttsModel.value !== s.model
    || ttsVoice.value !== s.voice
    || ttsSpeed.value !== s.speed
})

const initTtsState = () => {
  ttsInitializing = true
  const s = configStore.ttsSettings
  ttsEnabled.value = s.enabled
  ttsPresetId.value = s.preset || 'openai'
  ttsApiUrl.value = s.apiUrl
  ttsApiKey.value = s.apiKey
  ttsModel.value = s.model
  ttsVoice.value = s.voice
  ttsSpeed.value = s.speed
  ttsAutoSpeak.value = s.autoSpeak
  ttsSaved.value = false
  nextTick(() => { ttsInitializing = false })
}

watch(ttsPresetId, (newId) => {
  if (ttsInitializing) return
  const preset = ttsPresets.find(p => p.id === newId)
  if (!preset || newId === 'custom') return
  ttsApiUrl.value = preset.apiUrl
  ttsModel.value = preset.defaultModel
  ttsVoice.value = preset.defaultVoice
  ttsSaved.value = false
})

watch(ttsEnabled, () => {
  if (ttsInitializing) return
  saveTtsToggles()
})

watch(ttsAutoSpeak, () => {
  if (ttsInitializing) return
  saveTtsToggles()
})

async function saveTtsToggles() {
  const s = configStore.ttsSettings
  await configStore.saveTtsSettings({
    ...s,
    enabled: ttsEnabled.value,
    autoSpeak: ttsAutoSpeak.value,
  })
}

async function saveTtsConfig() {
  await configStore.saveTtsSettings({
    enabled: ttsEnabled.value,
    providerId: ttsSelectedPreset.value.providerId,
    preset: ttsPresetId.value,
    apiUrl: ttsApiUrl.value,
    apiKey: ttsApiKey.value,
    model: ttsModel.value,
    voice: ttsVoice.value,
    speed: ttsSpeed.value,
    autoSpeak: ttsAutoSpeak.value,
  })
  ttsSaved.value = true
  setTimeout(() => { ttsSaved.value = false }, 2000)
}

function openTtsKeyUrl() {
  const url = ttsSelectedPreset.value.keyUrl
  if (url) window.open(url, '_blank')
}

async function testTts() {
  const text = t('settings.tts.defaultTestText')
  ttsIsTesting.value = true
  ttsTestError.value = ''
  try {
    await saveTtsConfig()
    const result = await window.electronAPI.tts.synthesize(text, {
      voice: ttsVoice.value,
      model: ttsModel.value,
      speed: ttsSpeed.value,
    })
    if (!result.success) {
      ttsTestError.value = result.error || t('settings.tts.testFailed')
      return
    }
    if (result.audio) {
      const ctx = new AudioContext()
      const buffer = await ctx.decodeAudioData(result.audio.slice(0))
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(0)
      source.onended = () => ctx.close()
    }
  } catch (err) {
    ttsTestError.value = err instanceof Error ? err.message : String(err)
  } finally {
    ttsIsTesting.value = false
  }
}

// ==================== Web 搜索 ====================

const webSearchEnabled = ref(false)
const webSearchProviderId = ref<WebSearchProviderId>('bocha')
const webSearchApiKeys = ref<Partial<Record<WebSearchProviderId, string>>>({})
const webSearchSaved = ref(false)
let webSearchInitializing = true

const webSearchProviderList = WEB_SEARCH_PROVIDERS
const webSearchSelectedProvider = computed(() =>
  WEB_SEARCH_PROVIDERS.find(p => p.id === webSearchProviderId.value)
)

const webSearchApiKey = computed({
  get: () => webSearchApiKeys.value[webSearchProviderId.value] || '',
  set: (v: string) => { webSearchApiKeys.value = { ...webSearchApiKeys.value, [webSearchProviderId.value]: v } },
})

const webSearchKeyUrls: Record<string, string> = {
  bocha: 'https://open.bochaai.com/api-keys',
  jina: 'https://jina.ai/api-dashboard/key-manager',
  tavily: 'https://app.tavily.com/home',
}
const webSearchKeyUrl = computed(() => webSearchKeyUrls[webSearchProviderId.value] || '')

const webSearchDirty = computed(() => {
  const s = configStore.webSearchSettings
  return webSearchProviderId.value !== s.providerId
    || JSON.stringify(webSearchApiKeys.value) !== JSON.stringify(s.apiKeys || {})
})

onMounted(() => {
  const s = configStore.webSearchSettings
  webSearchEnabled.value = s.enabled
  webSearchProviderId.value = s.providerId
  webSearchApiKeys.value = { ...(s.apiKeys || {}) }
  nextTick(() => { webSearchInitializing = false })
})

watch(webSearchEnabled, () => {
  if (webSearchInitializing) return
  saveWebSearchConfig()
})

async function saveWebSearchConfig() {
  await configStore.saveWebSearchSettings({
    enabled: webSearchEnabled.value,
    providerId: webSearchProviderId.value,
    apiKeys: { ...webSearchApiKeys.value },
  })
  webSearchSaved.value = true
  setTimeout(() => { webSearchSaved.value = false }, 2000)
}

function openWebSearchKeyUrl() {
  const url = webSearchKeyUrl.value
  if (url) window.open(url, '_blank')
}

</script>

<template>
  <div class="ai-settings">
    <!-- Steam 版：仅显示说明，不提供任何 AI/API 配置入口 -->
    <div v-if="isSteamBuild" class="settings-section steam-notice">
      <p class="section-desc">{{ t('aiSettings.steamNoAiConfig') }}</p>
    </div>

    <!-- 非 Steam 版：完整 AI 模型配置 -->
    <template v-if="!isSteamBuild">
      <div class="settings-section">
        <div class="section-header">
          <h4>{{ t('aiSettings.title') }}</h4>
          <button class="btn btn-primary btn-sm" @click="openNewProfile">
            <Plus :size="14" />
            {{ t('aiSettings.addProfile') }}
          </button>
        </div>
        <p class="section-desc">
          {{ t('aiSettings.apiKeyNotRequired') }}
        </p>

        <!-- 配置列表 -->
        <div class="profile-list">
          <div
            v-for="profile in profiles"
            :key="profile.id"
            class="profile-item"
            :class="{ active: profile.id === activeProfileId }"
          >
            <div class="profile-radio">
              <input
                type="radio"
                :id="profile.id"
                :checked="profile.id === activeProfileId"
                @change="setActive(profile.id)"
              />
            </div>
            <div class="profile-info" @click="setActive(profile.id)">
              <div class="profile-name">
                {{ profile.name }}
                <span v-if="profile.modelType === 'vision'" class="model-type-badge vision">
                  <Eye :size="10" />
                  {{ t('aiSettings.modelTypeVision') }}
                </span>
              </div>
              <div class="profile-detail">{{ profile.model }} · {{ profile.apiUrl }}</div>
            </div>
            <div class="profile-actions">
              <button class="btn-icon btn-sm" @click="openEditProfile(profile)" :title="t('aiSettings.editProfile')">
                <Pencil :size="14" />
              </button>
              <button class="btn-icon btn-sm" @click="deleteProfile(profile)" :title="t('aiSettings.deleteProfile')">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <div v-if="profiles.length === 0" class="empty-profiles">
            <p>{{ t('aiSettings.noProfiles') }}</p>
            <p class="tip">{{ t('aiSettings.addProfile') }}</p>
          </div>
        </div>
      </div>

    </template>

    <!-- 添加/编辑表单弹窗 -->
    <Teleport to="body">
      <Transition name="profile-modal">
        <div v-if="showForm" class="profile-modal-overlay">
          <div class="profile-modal">
            <div class="form-header">
              <h4>{{ editingProfile ? t('aiSettings.editProfile') : t('aiSettings.addProfile') }}</h4>
              <button class="btn-icon" @click="showForm = false" :title="t('common.close')">
                <X :size="16" />
              </button>
            </div>

            <!-- 快速模板 -->
            <div class="templates" v-if="!editingProfile">
              <span class="template-label">{{ t('setup.aiConfig.quickTemplates') }}</span>
              <button
                v-for="template in templates"
                :key="template.name"
                class="template-btn"
                @click="applyTemplate(template)"
              >
                {{ template.name }}
              </button>
            </div>

            <div class="form-body">
              <div class="form-group">
                <label class="form-label">{{ t('aiSettings.profileName') }} *</label>
                <input v-model="formData.name" type="text" class="input" :placeholder="t('aiSettings.profileNamePlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('aiSettings.apiUrl') }} *</label>
                <input v-model="formData.apiUrl" type="text" class="input" :placeholder="t('aiSettings.apiUrlPlaceholder')" />
              </div>
              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">{{ t('aiSettings.apiKey') }}</label>
                  <button
                    v-if="currentKeyUrl"
                    class="get-key-btn"
                    @click="openKeyUrl(currentKeyUrl)"
                    :title="t('aiSettings.getApiKey')"
                  >
                    <ExternalLink :size="12" />
                    <span>{{ t('aiSettings.getApiKey') }}</span>
                  </button>
                </div>
                <input v-model="formData.apiKey" type="password" class="input" :placeholder="t('aiSettings.apiKeyPlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('aiSettings.model') }} *</label>
                <input v-model="formData.model" type="text" class="input" :placeholder="t('aiSettings.modelPlaceholder')" />
              </div>
              <div class="form-row">
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.contextLength') }}（K）</label>
                  <input v-model.number="contextLengthInK" type="number" class="input" placeholder="128" min="1" max="2000" />
                  <span class="form-hint">DeepSeek(64)、GPT-4o(128)、Claude(200)、Gemini(1000)</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.maxOutputTokens') }}（{{ t('aiSettings.maxOutputTokensHint') }}）</label>
                  <input v-model.number="formData.maxOutputTokens" type="number" class="input" placeholder="8192" min="1" max="128000" />
                  <span class="form-hint">{{ t('aiSettings.maxOutputTokensTip') }}</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">Temperature（{{ t('aiSettings.temperatureHint') }}）</label>
                  <input v-model.number="formData.temperature" type="number" class="input" placeholder="0.7" min="0" max="2" step="0.1" />
                  <span class="form-hint">{{ t('aiSettings.temperatureTip') }}</span>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('aiSettings.proxy') }}</label>
                <input v-model="formData.proxy" type="text" class="input" :placeholder="t('aiSettings.proxyPlaceholder')" />
              </div>
              <div class="form-row">
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.modelType') }}</label>
                  <select v-model="formData.modelType" class="input">
                    <option value="general">{{ t('aiSettings.modelTypeGeneral') }}</option>
                    <option value="vision">{{ t('aiSettings.modelTypeVision') }}</option>
                  </select>
                  <span class="form-hint">{{ t('aiSettings.modelTypeHint') }}</span>
                </div>
                <div class="form-group flex-1" v-if="formData.modelType !== 'vision'">
                  <label class="form-label">{{ t('aiSettings.visionProfile') }}</label>
                  <select v-model="formData.visionProfileId" class="input">
                    <option :value="undefined">{{ t('aiSettings.visionProfileNone') }}</option>
                    <option
                      v-for="vp in visionProfileOptions"
                      :key="vp.id"
                      :value="vp.id"
                    >
                      {{ vp.name }} ({{ vp.model }})
                    </option>
                  </select>
                  <span class="form-hint">{{ t('aiSettings.visionProfileHint') }}</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.apiFormat') }}</label>
                  <select v-model="formData.apiFormat" class="input">
                    <option value="auto">{{ t('aiSettings.apiFormatAuto') }}</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                  <span class="form-hint">{{ t('aiSettings.apiFormatHint') }}</span>
                </div>
              </div>
            </div>
            <div class="form-footer">
              <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
              <button class="btn btn-primary" @click="saveProfile">{{ t('common.save') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 自动使用视觉模型 -->
    <div v-if="!isSteamBuild" class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.autoVisionModel') }}</h4>
        <label class="toggle-switch">
          <input 
            type="checkbox" 
            :checked="configStore.autoVisionModel" 
            @change="configStore.setAutoVisionModel(($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.autoVisionModelDesc') }}
      </p>
    </div>

    <!-- 语音合成（TTS） -->
    <div v-if="!isSteamBuild" class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.tts.title') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="ttsEnabled"
            @change="ttsEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">{{ t('settings.tts.description') }}</p>

      <template v-if="ttsEnabled">
        <div class="tts-form-fields">
          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.provider') }}</label>
            <select v-model="ttsPresetId" class="input">
              <optgroup :label="t('settings.tts.groupInternational')">
                <option v-for="p in ttsInternationalPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </optgroup>
              <optgroup :label="t('settings.tts.groupDomestic')">
                <option v-for="p in ttsDomesticPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </optgroup>
              <optgroup :label="t('settings.tts.groupOther')">
                <option v-for="p in ttsOtherPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </optgroup>
            </select>
          </div>

          <div v-if="ttsIsCustom" class="form-group">
            <label class="form-label">{{ t('settings.tts.apiUrl') }}</label>
            <input v-model="ttsApiUrl" type="text" class="input" placeholder="https://api.example.com/v1/audio/speech" />
            <span class="form-hint">{{ t('settings.tts.apiUrlHint') }}</span>
          </div>

          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label">{{ ttsSelectedPreset.keyLabel || t('settings.tts.apiKey') }}</label>
              <button
                v-if="ttsSelectedPreset.keyUrl"
                class="get-key-btn"
                @click="openTtsKeyUrl"
              >
                <ExternalLink :size="12" />
                <span>{{ t('settings.tts.getKey') }}</span>
              </button>
            </div>
            <input v-model="ttsApiKey" type="password" class="input" :placeholder="ttsSelectedPreset.keyPlaceholder || 'API Key'" />
          </div>

          <div class="form-row">
            <div class="form-group flex-1">
              <label class="form-label">{{ ttsSelectedPreset.modelLabel || t('settings.tts.model') }}</label>
              <select v-if="ttsSelectedPreset.models.length > 0" v-model="ttsModel" class="input">
                <option v-for="m in ttsSelectedPreset.models" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="ttsModel" type="text" class="input" :placeholder="ttsSelectedPreset.modelPlaceholder || t('settings.tts.modelPlaceholder')" />
            </div>
            <div class="form-group flex-1">
              <label class="form-label">{{ t('settings.tts.voice') }}</label>
              <select v-if="ttsSelectedPreset.voices.length > 0" v-model="ttsVoice" class="input">
                <option v-for="v in ttsSelectedPreset.voices" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
              <input v-else v-model="ttsVoice" type="text" class="input" :placeholder="t('settings.tts.voicePlaceholder')" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.speed') }}: {{ ttsSpeed.toFixed(1) }}x</label>
            <input v-model.number="ttsSpeed" type="range" min="0.5" max="2.0" step="0.1" class="tts-range-slider" />
          </div>

          <div class="form-group tts-auto-speak">
            <label class="toggle-switch toggle-switch-sm">
              <input
                type="checkbox"
                :checked="ttsAutoSpeak"
                @change="ttsAutoSpeak = ($event.target as HTMLInputElement).checked"
              />
              <span class="toggle-slider"></span>
            </label>
            <div>
              <span class="tts-auto-speak-label">{{ t('settings.tts.autoSpeak') }}</span>
              <span class="form-hint">{{ t('settings.tts.autoSpeakHint') }}</span>
            </div>
          </div>

          <div class="form-group">
            <div class="tts-test-row">
              <button
                class="btn btn-primary btn-sm"
                :disabled="ttsIsTesting || !ttsApiKey"
                @click="testTts"
              >
                {{ ttsIsTesting ? t('settings.tts.testing') : t('settings.tts.testPlay') }}
              </button>
              <button
                class="btn btn-sm"
                :class="ttsSaved ? 'btn-success' : 'btn-save'"
                :disabled="!ttsDirty && !ttsSaved"
                @click="saveTtsConfig"
              >
                {{ ttsSaved ? t('settings.tts.saved') : t('settings.tts.save') }}
              </button>
              <span v-if="ttsDirty" class="form-hint tts-dirty-hint">{{ t('settings.tts.unsaved') }}</span>
            </div>
            <div v-if="ttsTestError" class="tts-error-msg">{{ ttsTestError }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- Web 搜索 -->
    <div v-if="!isSteamBuild" class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.webSearch.title') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="webSearchEnabled"
            @change="webSearchEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">{{ t('settings.webSearch.description') }}</p>

      <template v-if="webSearchEnabled">
        <div class="tts-form-fields">
          <div class="form-group">
            <label class="form-label">{{ t('settings.webSearch.provider') }}</label>
            <select v-model="webSearchProviderId" class="input">
              <option v-for="p in webSearchProviderList" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <span class="form-hint">{{ webSearchSelectedProvider?.description }}</span>
          </div>

          <div v-if="webSearchSelectedProvider?.requiresApiKey" class="form-group">
            <div class="form-label-row">
              <label class="form-label">API Key</label>
              <button
                v-if="webSearchKeyUrl"
                class="get-key-btn"
                @click="openWebSearchKeyUrl"
              >
                <ExternalLink :size="12" />
                <span>{{ t('settings.webSearch.getKey') }}</span>
              </button>
            </div>
            <input v-model="webSearchApiKey" type="password" class="input" placeholder="API Key" />
          </div>

          <div class="form-group">
            <button
              class="btn btn-sm"
              :class="webSearchSaved ? 'btn-success' : 'btn-save'"
              :disabled="!webSearchDirty && !webSearchSaved"
              @click="saveWebSearchConfig"
            >
              {{ webSearchSaved ? t('settings.webSearch.saved') : t('settings.webSearch.save') }}
            </button>
            <span v-if="webSearchDirty" class="form-hint tts-dirty-hint">{{ t('settings.webSearch.unsaved') }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- Agent 调试、日志（仅非 Steam 版） -->
    <template v-if="!isSteamBuild">
      <div class="settings-section">
        <div class="section-header">
          <h4>{{ t('aiSettings.agentDebugMode') }}</h4>
          <label class="toggle-switch">
            <input 
              type="checkbox" 
              :checked="debugMode" 
              @change="configStore.setAgentDebugMode(($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="section-desc">
          {{ t('aiSettings.agentDebugModeDesc') }}
        </p>
      </div>

      <div class="settings-section">
        <div class="section-header">
          <h4>{{ t('aiSettings.logLevel') }}</h4>
          <select 
            class="log-level-select"
            :value="configStore.logLevel"
            @change="configStore.setLogLevel(($event.target as HTMLSelectElement).value as import('../../utils/logger').LogLevel)"
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="silent">Silent</option>
          </select>
        </div>
        <p class="section-desc">
          {{ t('aiSettings.logLevelDesc') }}
        </p>
        <div class="log-dir-actions">
          <button class="open-log-dir-btn" @click="openLogDir">
            {{ t('aiSettings.openLogDir') }}
          </button>
          <button class="open-log-dir-btn" @click="openAiDebugLogDir">
            {{ t('aiSettings.openAiDebugLogDir') }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.profile-item:hover {
  border-color: var(--accent-primary);
}

.profile-item.active {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.1);
}

.profile-radio input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.profile-info {
  flex: 1;
  min-width: 0;
}

.profile-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.model-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 8px;
}

.model-type-badge.vision {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.15);
}

.profile-detail {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-actions {
  display: flex;
  gap: 4px;
}

.empty-profiles {
  padding: 30px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-profiles .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 弹窗 */
.profile-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.profile-modal {
  width: 90%;
  max-width: 560px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.profile-modal .form-body {
  overflow-y: auto;
}

/* 弹窗动画 */
.profile-modal-enter-active,
.profile-modal-leave-active {
  transition: opacity 0.2s ease;
}

.profile-modal-enter-active .profile-modal,
.profile-modal-leave-active .profile-modal {
  transition: transform 0.2s ease;
}

.profile-modal-enter-from,
.profile-modal-leave-to {
  opacity: 0;
}

.profile-modal-enter-from .profile-modal {
  transform: scale(0.95) translateY(10px);
}

.profile-modal-leave-to .profile-modal {
  transform: scale(0.95) translateY(10px);
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
}

.form-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.templates {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.template-label {
  font-size: 12px;
  color: var(--text-muted);
}

.template-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.template-btn:hover {
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.get-key-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.get-key-btn:hover {
  background: var(--accent-primary);
  color: white;
}

.form-body {
  padding: 16px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

.form-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: 0.3s;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 2px;
  bottom: 2px;
  background-color: var(--text-muted);
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
  background-color: white;
}

.log-level-select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #555);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
  font-size: 13px;
  cursor: pointer;
  outline: none;
}

.log-level-select:focus {
  border-color: var(--accent-primary);
}

.open-log-dir-btn {
  margin-top: 8px;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #555);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-secondary, #aaa);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.open-log-dir-btn:hover {
  background: var(--bg-hover, #333);
  color: var(--text-primary, #e0e0e0);
  border-color: var(--accent-primary);
}

.log-dir-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* TTS 语音合成 */
.tts-form-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 4px;
}

.tts-form-fields .form-group {
  margin-bottom: 0;
}

.tts-range-slider {
  width: 100%;
  accent-color: var(--accent-primary);
}

.tts-auto-speak {
  flex-direction: row !important;
  align-items: center;
  gap: 10px;
}

.tts-auto-speak-label {
  font-size: 13px;
  color: var(--text-primary);
}

.toggle-switch-sm {
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.toggle-switch-sm .toggle-slider:before {
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
}

.toggle-switch-sm input:checked + .toggle-slider:before {
  transform: translateX(16px);
}

.tts-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-save {
  background: var(--accent-primary, #4a9eff);
  color: white;
}

.btn-save:disabled {
  opacity: 0.4;
}

.btn-success {
  background: var(--color-success);
  color: white;
}

.tts-dirty-hint {
  color: var(--accent-primary, #4a9eff) !important;
}

.tts-error-msg {
  margin-top: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.1);
  border-radius: 6px;
}

</style>

