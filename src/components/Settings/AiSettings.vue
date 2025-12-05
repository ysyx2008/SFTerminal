<script setup lang="ts">
import { ref, computed } from 'vue'
import { useConfigStore, type AiProfile } from '../../stores/config'
import { v4 as uuidv4 } from 'uuid'

const configStore = useConfigStore()

const showForm = ref(false)
const editingProfile = ref<AiProfile | null>(null)

const formData = ref<Partial<AiProfile>>({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  proxy: '',
  contextLength: 8000
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
    contextLength: 8000
  }
  editingProfile.value = null
}

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
  if (!formData.value.name || !formData.value.apiUrl || !formData.value.apiKey || !formData.value.model) {
    return
  }

  if (editingProfile.value) {
    await configStore.updateAiProfile({
      ...editingProfile.value,
      ...formData.value
    } as AiProfile)
  } else {
    await configStore.addAiProfile({
      id: uuidv4(),
      ...formData.value
    } as AiProfile)
  }

  showForm.value = false
  resetForm()
}

const deleteProfile = async (profile: AiProfile) => {
  if (confirm(`确定要删除配置 "${profile.name}" 吗？`)) {
    await configStore.deleteAiProfile(profile.id)
  }
}

const setActive = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// 预设模板
const templates = [
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo'
  },
  {
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo'
  },
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat'
  },
  {
    name: 'Ollama 本地',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama2'
  }
]

const applyTemplate = (template: typeof templates[0]) => {
  formData.value.name = template.name
  formData.value.apiUrl = template.apiUrl
  formData.value.model = template.model
}
</script>

<template>
  <div class="ai-settings">
    <div class="settings-section">
      <div class="section-header">
        <h4>AI 模型配置</h4>
        <button class="btn btn-primary btn-sm" @click="openNewProfile">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          添加配置
        </button>
      </div>
      <p class="section-desc">
        配置 AI 模型 API，支持 OpenAI 兼容接口（包括 vLLM、FastChat、Ollama 等私有化部署）
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
            <div class="profile-name">{{ profile.name }}</div>
            <div class="profile-detail">{{ profile.model }} · {{ profile.apiUrl }}</div>
          </div>
          <div class="profile-actions">
            <button class="btn-icon btn-sm" @click="openEditProfile(profile)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="btn-icon btn-sm" @click="deleteProfile(profile)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div v-if="profiles.length === 0" class="empty-profiles">
          <p>尚未添加 AI 配置</p>
          <p class="tip">点击"添加配置"开始使用 AI 功能</p>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单 -->
    <div v-if="showForm" class="profile-form">
      <div class="form-header">
        <h4>{{ editingProfile ? '编辑配置' : '添加配置' }}</h4>
        <button class="btn-icon" @click="showForm = false">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 快速模板 -->
      <div class="templates" v-if="!editingProfile">
        <span class="template-label">快速填充：</span>
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
          <label class="form-label">配置名称 *</label>
          <input v-model="formData.name" type="text" class="input" placeholder="例如：公司内网模型" />
        </div>
        <div class="form-group">
          <label class="form-label">API 地址 *</label>
          <input v-model="formData.apiUrl" type="text" class="input" placeholder="http://10.0.1.100:8080/v1/chat/completions" />
        </div>
        <div class="form-group">
          <label class="form-label">API Key *</label>
          <input v-model="formData.apiKey" type="password" class="input" placeholder="sk-..." />
        </div>
        <div class="form-group">
          <label class="form-label">模型名称 *</label>
          <input v-model="formData.model" type="text" class="input" placeholder="例如：qwen-72b, gpt-3.5-turbo" />
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">上下文长度（tokens）</label>
            <input v-model.number="formData.contextLength" type="number" class="input" placeholder="8000" />
            <span class="form-hint">常见值：GPT-3.5(4K/16K)、GPT-4(8K/128K)、Claude(200K)、Qwen(32K)</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">代理地址（可选）</label>
          <input v-model="formData.proxy" type="text" class="input" placeholder="http://proxy:3128 或 socks5://proxy:1080" />
        </div>
      </div>
      <div class="form-footer">
        <button class="btn" @click="showForm = false">取消</button>
        <button class="btn btn-primary" @click="saveProfile">保存</button>
      </div>
    </div>
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
  margin-bottom: 16px;
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
  background: rgba(137, 180, 250, 0.1);
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
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
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

/* 表单 */
.profile-form {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
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
  color: var(--bg-primary);
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
</style>

