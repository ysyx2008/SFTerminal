<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SshSession } from '../stores/config'

const { t } = useI18n()

const props = defineProps<{
  session: SshSession
}>()

const emit = defineEmits<{
  connect: [credentials: { username: string; password: string; save: boolean }]
  cancel: []
}>()

const username = ref(props.session.username || '')
const password = ref('')
const saveCredentials = ref(true)

watch(() => props.session, (s) => {
  username.value = s.username || ''
  password.value = ''
})

function handleConnect() {
  if (!username.value.trim()) return
  emit('connect', {
    username: username.value.trim(),
    password: password.value,
    save: saveCredentials.value
  })
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    handleConnect()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="credential-overlay" @click.self="emit('cancel')">
    <div class="credential-dialog">
      <h3>{{ t('session.credentialDialog.title') }}</h3>
      <p class="dialog-hint">{{ session.name }} ({{ session.host }}:{{ session.port }})</p>

      <div class="form-group">
        <label class="form-label">{{ t('session.credentialDialog.username') }}</label>
        <input
          v-model="username"
          type="text"
          class="input-field"
          autofocus
          :placeholder="t('session.credentialDialog.usernamePlaceholder')"
        />
      </div>

      <div class="form-group">
        <label class="form-label">{{ t('session.credentialDialog.password') }}</label>
        <input
          v-model="password"
          type="password"
          class="input-field"
          autocomplete="new-password"
          :placeholder="t('session.credentialDialog.passwordPlaceholder')"
        />
      </div>

      <label class="save-checkbox">
        <input type="checkbox" v-model="saveCredentials" />
        <span>{{ t('session.credentialDialog.saveCredentials') }}</span>
      </label>

      <div class="dialog-actions">
        <button class="btn btn-secondary" @click="emit('cancel')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="!username.trim()" @click="handleConnect">{{ t('session.credentialDialog.connect') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.credential-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.credential-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 20px 24px;
  width: 360px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
}

.credential-dialog h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}

.dialog-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.form-group {
  margin-bottom: 12px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 5px;
  color: var(--text-primary);
}

.input-field {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.input-field:focus {
  border-color: var(--accent-primary);
}

.save-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  margin: 14px 0;
  cursor: pointer;
}

.save-checkbox input {
  accent-color: var(--accent-primary);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.btn {
  padding: 7px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-secondary);
}
</style>
