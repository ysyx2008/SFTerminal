<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useConfigStore, type SshSession, type SshEncoding, type JumpHostConfig } from '../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  session: SshSession | null
}>()

const emit = defineEmits<{
  save: [session: Partial<SshSession>]
  close: []
}>()

const encodingOptions: SshEncoding[] = [
  'utf-8', 'gbk', 'gb2312', 'gb18030', 'big5',
  'shift_jis', 'euc-jp', 'euc-kr',
  'iso-8859-1', 'iso-8859-15', 'windows-1252',
  'koi8-r', 'windows-1251'
]

const nameInputRef = ref<HTMLInputElement | null>(null)

type JumpHostMode = 'inherit' | 'custom' | 'disabled'
const jumpHostMode = ref<JumpHostMode>('inherit')
const jumpHostForm = ref<Partial<JumpHostConfig>>({
  host: '',
  port: 22,
  username: '',
  authType: 'password'
})

const formData = ref<Partial<SshSession>>({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  groupId: '',
  encoding: 'utf-8'
})

const inheritedJumpHost = computed(() => {
  const groupId = formData.value.groupId
  if (!groupId) return undefined
  const group = configStore.sessionGroups.find(g => g.id === groupId)
  if (!group?.jumpHost) return undefined
  return { groupName: group.name, host: group.jumpHost.host, port: group.jumpHost.port }
})

watch(() => props.session, (session) => {
  if (session) {
    formData.value = { ...session }
    if (session.jumpHostOverride === null) {
      jumpHostMode.value = 'disabled'
      jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
    } else if (session.jumpHostOverride) {
      jumpHostMode.value = 'custom'
      jumpHostForm.value = { ...session.jumpHostOverride }
    } else {
      jumpHostMode.value = 'inherit'
      jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
    }
  } else {
    formData.value = {
      name: '',
      host: '',
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      privateKeyPath: '',
      passphrase: '',
      groupId: '',
      encoding: 'utf-8'
    }
    jumpHostMode.value = 'inherit'
    jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
  }
  nextTick(() => nameInputRef.value?.focus())
}, { immediate: true })

const onJumpHostModeChange = (mode: JumpHostMode) => {
  jumpHostMode.value = mode
  if (mode === 'custom' && !jumpHostForm.value.host) {
    jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('close')
  }
}

const saveSession = () => {
  if (!formData.value.name?.trim()) {
    alert(t('session.validation.nameRequired'))
    return
  }
  if (!formData.value.host?.trim()) {
    alert(t('session.validation.hostRequired'))
    return
  }
  if (!formData.value.username?.trim()) {
    alert(t('session.validation.usernameRequired'))
    return
  }

  const data = { ...formData.value }
  if (jumpHostMode.value === 'custom') {
    if (!jumpHostForm.value.host || !jumpHostForm.value.username) {
      alert(t('session.pleaseInputJumpHostInfo'))
      return
    }
    data.jumpHostOverride = jumpHostForm.value as JumpHostConfig
  } else if (jumpHostMode.value === 'disabled') {
    data.jumpHostOverride = null
  } else {
    data.jumpHostOverride = undefined
  }

  emit('save', data)
}

</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="modal session-modal">
      <div class="modal-header">
        <h3>{{ session ? t('session.editHost') : t('session.newHost') }}</h3>
        <button class="btn-icon" @click="emit('close')" :title="t('common.close')">
          <X :size="16" />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">{{ t('session.form.name') }} *</label>
          <input ref="nameInputRef" v-model="formData.name" type="text" class="input" :placeholder="t('session.form.sessionNamePlaceholder')" />
        </div>
        <div class="form-row">
          <div class="form-group" style="flex: 2">
            <label class="form-label">{{ t('session.form.host') }} *</label>
            <input v-model="formData.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
          </div>
          <div class="form-group" style="flex: 1">
            <label class="form-label">{{ t('session.form.port') }}</label>
            <input v-model.number="formData.port" type="number" class="input" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.username') }} *</label>
          <input v-model="formData.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.authType') }}</label>
          <select v-model="formData.authType" class="select">
            <option value="password">{{ t('session.form.authPassword') }}</option>
            <option value="privateKey">{{ t('session.form.authKey') }}</option>
          </select>
        </div>
        <div v-if="formData.authType === 'password'" class="form-group">
          <label class="form-label">{{ t('session.form.password') }}</label>
          <input v-model="formData.password" type="password" class="input" />
        </div>
        <template v-else>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
            <input v-model="formData.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
            <input v-model="formData.passphrase" type="password" class="input" />
          </div>
        </template>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.group') }}</label>
          <select v-model="formData.groupId" class="select">
            <option value="">{{ t('session.defaultGroup') }}</option>
            <option v-for="group in configStore.sessionGroups" :key="group.id" :value="group.id">
              {{ group.name }}
              <template v-if="group.jumpHost"> ({{ t('session.form.jumpHost') }}: {{ group.jumpHost.host }})</template>
            </option>
          </select>
        </div>
        <!-- 跳板机配置 -->
        <div class="form-section">
          <div class="form-group" style="margin-bottom: 0">
            <label class="form-label">{{ t('session.form.jumpHost') }}</label>
            <select :value="jumpHostMode" @change="onJumpHostModeChange(($event.target as HTMLSelectElement).value as JumpHostMode)" class="select">
              <option value="inherit">{{ t('session.form.jumpHostInherit') }}</option>
              <option value="custom">{{ t('session.form.jumpHostCustom') }}</option>
              <option value="disabled">{{ t('session.form.jumpHostDisable') }}</option>
            </select>
            <span v-if="jumpHostMode === 'inherit' && inheritedJumpHost" class="form-hint">
              {{ t('session.form.jumpHostInheritInfo', { group: inheritedJumpHost.groupName, host: inheritedJumpHost.host + ':' + inheritedJumpHost.port }) }}
            </span>
            <span v-else-if="jumpHostMode === 'inherit' && !inheritedJumpHost" class="form-hint">
              {{ t('session.form.jumpHostNoInherit') }}
            </span>
            <span v-if="jumpHostMode === 'custom'" class="form-hint">
              {{ t('session.form.jumpHostCustomHint') }}
            </span>
          </div>

          <template v-if="jumpHostMode === 'custom'">
            <div class="form-row" style="margin-top: 10px">
              <div class="form-group" style="flex: 2">
                <label class="form-label">{{ t('session.form.jumpHostHost') }} *</label>
                <input v-model="jumpHostForm.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
              </div>
              <div class="form-group" style="flex: 1">
                <label class="form-label">{{ t('session.form.port') }}</label>
                <input v-model.number="jumpHostForm.port" type="number" class="input" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.username') }} *</label>
              <input v-model="jumpHostForm.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.authType') }}</label>
              <select v-model="jumpHostForm.authType" class="select">
                <option value="password">{{ t('session.form.authPassword') }}</option>
                <option value="privateKey">{{ t('session.form.authKey') }}</option>
              </select>
            </div>
            <div v-if="jumpHostForm.authType === 'password'" class="form-group">
              <label class="form-label">{{ t('session.form.password') }}</label>
              <input v-model="jumpHostForm.password" type="password" class="input" />
            </div>
            <template v-else>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
                <input v-model="jumpHostForm.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
                <input v-model="jumpHostForm.passphrase" type="password" class="input" />
              </div>
            </template>
          </template>
        </div>

        <div class="form-group">
          <label class="form-label">{{ t('session.form.encoding') }}</label>
          <select v-model="formData.encoding" class="select">
            <option v-for="enc in encodingOptions" :key="enc" :value="enc">
              {{ t(`session.form.encodings.${enc}`) }}
            </option>
          </select>
          <span class="form-hint">{{ t('session.form.encodingHint') }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="saveSession">{{ t('common.save') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.form-hint {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.form-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

</style>
