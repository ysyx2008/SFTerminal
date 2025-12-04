<script setup lang="ts">
import { ref, onMounted } from 'vue'

// 存储统计
const storageStats = ref<{
  chatFiles: number
  agentFiles: number
  totalSize: number
  oldestRecord?: string
  newestRecord?: string
} | null>(null)

// 数据目录路径
const dataPath = ref('')

// 加载状态
const isLoading = ref(false)
const isExporting = ref(false)
const isImporting = ref(false)

// 消息提示
const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)

// 加载存储统计
const loadStorageStats = async () => {
  try {
    storageStats.value = await window.electronAPI.history.getStorageStats()
    dataPath.value = await window.electronAPI.history.getDataPath()
  } catch (e) {
    console.error('加载存储统计失败:', e)
  }
}

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 打开数据目录
const openDataFolder = async () => {
  try {
    await window.electronAPI.history.openDataFolder()
  } catch (e) {
    showMessage('error', '打开目录失败')
  }
}

// 导出选项
const exportOptions = ref({
  includeSshPasswords: false,
  includeApiKeys: false
})

// 导出到文件夹
const exportToFolder = async () => {
  isExporting.value = true
  try {
    const result = await window.electronAPI.history.exportToFolder(exportOptions.value)
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', `已导出 ${result.files?.length || 0} 个文件`)
    } else {
      showMessage('error', result.error || '导出失败')
    }
  } catch (e) {
    showMessage('error', `导出失败: ${e}`)
  } finally {
    isExporting.value = false
  }
}

// 导出单文件（旧方式，保留兼容）
const exportSingleFile = async () => {
  isExporting.value = true
  try {
    const data = await window.electronAPI.history.exportData()
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sfterm-backup-${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    
    showMessage('success', '数据导出成功')
  } catch (e) {
    showMessage('error', `导出失败: ${e}`)
  } finally {
    isExporting.value = false
  }
}

// 从文件夹导入
const importFromFolder = async () => {
  isImporting.value = true
  try {
    const result = await window.electronAPI.history.importFromFolder()
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', `已导入: ${result.imported?.join(', ') || '无'}`)
      await loadStorageStats()
    } else {
      showMessage('error', result.error || '导入失败')
    }
  } catch (e) {
    showMessage('error', `导入失败: ${e}`)
  } finally {
    isImporting.value = false
  }
}

// 导入单文件（旧方式，保留兼容）
const importSingleFile = async () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    
    isImporting.value = true
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      
      const result = await window.electronAPI.history.importData(data)
      
      if (result.success) {
        showMessage('success', '数据导入成功')
        await loadStorageStats()
      } else {
        showMessage('error', result.error || '导入失败')
      }
    } catch (e) {
      showMessage('error', `导入失败: ${e}`)
    } finally {
      isImporting.value = false
    }
  }
  
  input.click()
}

// 清理旧记录
const cleanupOldRecords = async (days: number) => {
  if (!confirm(`确定要清理 ${days} 天前的历史记录吗？此操作不可恢复。`)) {
    return
  }
  
  isLoading.value = true
  try {
    const result = await window.electronAPI.history.cleanup(days)
    showMessage('success', `已清理 ${result.chatDeleted} 个聊天文件和 ${result.agentDeleted} 个 Agent 文件`)
    await loadStorageStats()
  } catch (e) {
    showMessage('error', `清理失败: ${e}`)
  } finally {
    isLoading.value = false
  }
}

// 显示消息
const showMessage = (type: 'success' | 'error', text: string) => {
  message.value = { type, text }
  setTimeout(() => {
    message.value = null
  }, 3000)
}

onMounted(() => {
  loadStorageStats()
})
</script>

<template>
  <div class="data-settings">
    <h3>数据管理</h3>
    
    <!-- 消息提示 -->
    <div v-if="message" class="message" :class="message.type">
      {{ message.text }}
    </div>
    
    <!-- 存储统计 -->
    <div class="section">
      <h4>存储统计</h4>
      <div v-if="storageStats" class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">聊天记录</span>
          <span class="stat-value">{{ storageStats.chatFiles }} 天</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Agent 记录</span>
          <span class="stat-value">{{ storageStats.agentFiles }} 天</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">总大小</span>
          <span class="stat-value">{{ formatSize(storageStats.totalSize) }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">记录范围</span>
          <span class="stat-value">
            {{ storageStats.oldestRecord || '无' }} ~ {{ storageStats.newestRecord || '无' }}
          </span>
        </div>
      </div>
      <div v-else class="loading">加载中...</div>
    </div>
    
    <!-- 数据目录 -->
    <div class="section">
      <h4>数据目录</h4>
      <div class="data-path">
        <code>{{ dataPath }}</code>
        <button class="btn btn-sm" @click="openDataFolder">
          📂 打开目录
        </button>
      </div>
      <p class="hint">更换电脑时，可直接复制此目录下的文件进行迁移</p>
    </div>
    
    <!-- 导出/导入 -->
    <div class="section">
      <h4>备份与恢复</h4>
      
      <!-- 导出选项 -->
      <div class="export-options">
        <label class="checkbox-label">
          <input type="checkbox" v-model="exportOptions.includeSshPasswords">
          <span>包含 SSH 密码</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="exportOptions.includeApiKeys">
          <span>包含 API Key</span>
        </label>
      </div>
      
      <div class="actions">
        <button class="btn btn-primary" @click="exportToFolder" :disabled="isExporting">
          {{ isExporting ? '导出中...' : '📂 导出到文件夹' }}
        </button>
        <button class="btn" @click="importFromFolder" :disabled="isImporting">
          {{ isImporting ? '导入中...' : '📂 从文件夹导入' }}
        </button>
      </div>
      <p class="hint">导出为独立文件，可选择性分享给他人</p>
      
      <div class="actions" style="margin-top: 8px;">
        <button class="btn btn-sm btn-outline" @click="exportSingleFile" :disabled="isExporting">
          📄 导出单文件
        </button>
        <button class="btn btn-sm btn-outline" @click="importSingleFile" :disabled="isImporting">
          📄 导入单文件
        </button>
      </div>
      <p class="hint">单文件适合完整备份，包含所有数据</p>
    </div>
    
    <!-- 清理 -->
    <div class="section">
      <h4>清理历史</h4>
      <div class="actions">
        <button class="btn btn-outline" @click="cleanupOldRecords(30)" :disabled="isLoading">
          清理 30 天前
        </button>
        <button class="btn btn-outline" @click="cleanupOldRecords(90)" :disabled="isLoading">
          清理 90 天前
        </button>
        <button class="btn btn-outline btn-danger" @click="cleanupOldRecords(0)" :disabled="isLoading">
          清空全部
        </button>
      </div>
      <p class="hint">清理旧记录可释放存储空间，此操作不可恢复</p>
    </div>
  </div>
</template>

<style scoped>
.data-settings {
  max-width: 500px;
}

.data-settings h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 20px;
}

.section {
  margin-bottom: 24px;
}

.section h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.message {
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 16px;
  font-size: 13px;
}

.message.success {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.message.error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

.stat-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.data-path {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-bottom: 8px;
}

.data-path code {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.loading {
  color: var(--text-muted);
  font-size: 13px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-outline {
  background: transparent;
}

.btn-danger {
  color: #ef4444;
  border-color: #ef4444;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
}

.export-options {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
</style>

