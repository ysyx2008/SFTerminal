<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { useConfigStore, type SshSession } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { v4 as uuidv4 } from 'uuid'

const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const emit = defineEmits<{
  openSftp: [session: SshSession]
}>()

const showNewSession = ref(false)
const showImportMenu = ref(false)
const nameInputRef = ref<HTMLInputElement | null>(null)

// ESC 关闭弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (showNewSession.value) {
      showNewSession.value = false
      resetForm()
    }
    if (showImportMenu.value) {
      showImportMenu.value = false
    }
  }
}

// 点击外部关闭导入菜单
const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.import-dropdown')) {
    showImportMenu.value = false
  }
}

// 监听弹窗状态，添加/移除键盘事件
watch(showNewSession, (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('keydown', handleKeydown)
  }
})

// 监听导入菜单状态
watch(showImportMenu, (isOpen) => {
  if (isOpen) {
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('click', handleClickOutside)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('click', handleClickOutside)
})
const editingSession = ref<SshSession | null>(null)
const searchText = ref('')

// 表单数据
const formData = ref<Partial<SshSession>>({
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  group: ''
})

// 过滤后的会话列表
const filteredSessions = computed(() => {
  const text = searchText.value.toLowerCase()
  if (!text) return configStore.sshSessions
  return configStore.sshSessions.filter(
    s =>
      s.name.toLowerCase().includes(text) ||
      s.host.toLowerCase().includes(text) ||
      s.username.toLowerCase().includes(text)
  )
})

// 按组分类的会话
const groupedSessions = computed(() => {
  const groups: Record<string, SshSession[]> = {}
  filteredSessions.value.forEach(session => {
    const group = session.group || '默认'
    if (!groups[group]) {
      groups[group] = []
    }
    groups[group].push(session)
  })
  return groups
})

// 重置表单
const resetForm = () => {
  formData.value = {
    name: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    group: ''
  }
  editingSession.value = null
}

// 打开新建会话
const openNewSession = async () => {
  resetForm()
  showNewSession.value = true
  await nextTick()
  nameInputRef.value?.focus()
}

// 打开编辑会话
const openEditSession = async (session: SshSession) => {
  editingSession.value = session
  formData.value = { ...session }
  showNewSession.value = true
  await nextTick()
  nameInputRef.value?.focus()
}

// 保存会话
const saveSession = async () => {
  if (!formData.value.name || !formData.value.host || !formData.value.username) {
    return
  }

  if (editingSession.value) {
    // 更新
    await configStore.updateSshSession({
      ...editingSession.value,
      ...formData.value
    } as SshSession)
  } else {
    // 新建
    await configStore.addSshSession({
      id: uuidv4(),
      ...formData.value
    } as SshSession)
  }

  showNewSession.value = false
  resetForm()
}

// 删除会话
const deleteSession = async (session: SshSession) => {
  if (confirm(`确定要删除会话 "${session.name}" 吗？`)) {
    await configStore.deleteSshSession(session.id)
  }
}

// 连接会话
const connectSession = async (session: SshSession) => {
  await terminalStore.createTab('ssh', {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKey: session.privateKeyPath
  })
}

// 打开 SFTP 文件管理
const openSftp = (session: SshSession) => {
  emit('openSftp', session)
}

// 创建本地终端
const createLocalTerminal = () => {
  terminalStore.createTab('local')
}

// 导入 Xshell 会话文件
const importXshellFiles = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectFiles()
  if (result.canceled) return
  
  const importResult = await window.electronAPI.xshell.importFiles(result.filePaths)
  await handleImportResult(importResult)
}

// 导入 Xshell 会话目录
const importXshellDirectory = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectDirectory()
  if (result.canceled) return
  
  const importResult = await window.electronAPI.xshell.importDirectory(result.dirPath)
  await handleImportResult(importResult)
}

// 处理导入结果
const handleImportResult = async (importResult: { success: boolean; sessions: any[]; errors: string[] }) => {
  if (!importResult.success && importResult.sessions.length === 0) {
    alert(`导入失败：${importResult.errors.join('\n')}`)
    return
  }
  
  // 将导入的会话添加到列表
  let importedCount = 0
  for (const session of importResult.sessions) {
    await configStore.addSshSession({
      id: uuidv4(),
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      authType: session.privateKeyPath ? 'privateKey' : 'password',
      password: session.password,
      privateKeyPath: session.privateKeyPath,
      group: session.group
    })
    importedCount++
  }
  
  // 显示结果
  let message = `成功导入 ${importedCount} 个会话`
  if (importResult.errors.length > 0) {
    message += `\n\n以下文件导入失败：\n${importResult.errors.join('\n')}`
  }
  alert(message)
}
</script>

<template>
  <div class="session-manager">
    <!-- 搜索和操作栏 -->
    <div class="session-toolbar">
      <input
        v-model="searchText"
        type="text"
        class="input search-input"
        placeholder="搜索主机..."
      />
      <button class="btn btn-primary btn-sm" @click="openNewSession">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        新建
      </button>
      <div class="import-dropdown">
        <button class="btn btn-sm" @click="showImportMenu = !showImportMenu">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          导入
        </button>
        <div v-if="showImportMenu" class="import-menu" @click.stop>
          <button class="import-menu-item" @click="importXshellFiles">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            导入 Xshell 文件...
          </button>
          <button class="import-menu-item" @click="importXshellDirectory">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            导入 Xshell 目录...
          </button>
        </div>
      </div>
    </div>

    <!-- 快速操作 -->
    <div class="quick-connect">
      <button class="quick-btn" @click="createLocalTerminal">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <span>本地终端</span>
      </button>
    </div>

    <!-- 会话列表 -->
    <div class="session-list">
      <template v-if="Object.keys(groupedSessions).length > 0">
        <div
          v-for="(sessions, group) in groupedSessions"
          :key="group"
          class="session-group"
        >
          <div class="group-header" v-if="sessions.length > 0">
            <span>{{ group }}</span>
            <span class="group-count">{{ sessions.length }}</span>
          </div>
          <div
            v-for="session in sessions"
            :key="session.id"
            class="session-item"
            @dblclick="connectSession(session)"
          >
            <div class="session-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                <line x1="8" y1="21" x2="16" y2="21"/>
                <line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            <div class="session-info">
              <div class="session-name">{{ session.name }}</div>
              <div class="session-host">{{ session.username }}@{{ session.host }}:{{ session.port }}</div>
            </div>
            <div class="session-actions">
              <button class="btn-icon btn-sm" @click.stop="connectSession(session)" title="连接">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
              </button>
              <button class="btn-icon btn-sm" @click.stop="openSftp(session)" title="文件管理">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
              <button class="btn-icon btn-sm" @click.stop="openEditSession(session)" title="编辑">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button class="btn-icon btn-sm" @click.stop="deleteSession(session)" title="删除">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="empty-sessions">
        <template v-if="searchText">
          <p>未找到匹配的主机</p>
          <p class="tip">尝试其他关键词</p>
        </template>
        <template v-else>
          <p>暂无保存的会话</p>
          <p class="tip">点击"新建"添加 SSH 会话</p>
        </template>
      </div>
    </div>

    <!-- 新建/编辑会话弹窗 -->
    <div v-if="showNewSession" class="modal-overlay" @click.self="showNewSession = false">
      <div class="modal session-modal">
        <div class="modal-header">
          <h3>{{ editingSession ? '编辑会话' : '新建 SSH 会话' }}</h3>
          <button class="btn-icon" @click="showNewSession = false" title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">名称 *</label>
            <input ref="nameInputRef" v-model="formData.name" type="text" class="input" placeholder="例如：生产服务器" />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex: 2">
              <label class="form-label">主机 *</label>
              <input v-model="formData.host" type="text" class="input" placeholder="IP 或域名" />
            </div>
            <div class="form-group" style="flex: 1">
              <label class="form-label">端口</label>
              <input v-model.number="formData.port" type="number" class="input" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">用户名 *</label>
            <input v-model="formData.username" type="text" class="input" placeholder="root" />
          </div>
          <div class="form-group">
            <label class="form-label">认证方式</label>
            <select v-model="formData.authType" class="select">
              <option value="password">密码</option>
              <option value="privateKey">私钥</option>
            </select>
          </div>
          <div v-if="formData.authType === 'password'" class="form-group">
            <label class="form-label">密码</label>
            <input v-model="formData.password" type="password" class="input" />
          </div>
          <template v-else>
            <div class="form-group">
              <label class="form-label">私钥路径</label>
              <input v-model="formData.privateKeyPath" type="text" class="input" placeholder="~/.ssh/id_rsa" />
            </div>
            <div class="form-group">
              <label class="form-label">私钥密码（可选）</label>
              <input v-model="formData.passphrase" type="password" class="input" />
            </div>
          </template>
          <div class="form-group">
            <label class="form-label">分组（可选）</label>
            <input v-model="formData.group" type="text" class="input" placeholder="默认" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showNewSession = false">取消</button>
          <button class="btn btn-primary" @click="saveSession">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session-toolbar {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.search-input {
  flex: 1;
}

/* 工具栏按钮统一样式 */
.session-toolbar .btn {
  height: 32px;
  min-width: fit-content;
  white-space: nowrap;
}

/* 导入下拉菜单 */
.import-dropdown {
  position: relative;
}

.import-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 180px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.import-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}

.import-menu-item:hover {
  background: var(--bg-surface);
}

.import-menu-item svg {
  color: var(--text-muted);
}

.quick-connect {
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.quick-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-group {
  margin-bottom: 12px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
}

.group-count {
  background: var(--bg-surface);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.session-item:hover {
  background: var(--bg-surface);
}

.session-icon {
  color: var(--accent-primary);
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.session-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.empty-sessions {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-sessions .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 420px;
  max-height: 80vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

.form-row {
  display: flex;
  gap: 12px;
}
</style>

