<template>
  <div class="sso-gate" role="dialog" aria-modal="true">
    <div class="sso-gate-card">
      <h1 class="sso-gate-title">{{ t('sso.loginTitle') }}</h1>
      <p class="sso-gate-desc">{{ t('sso.loginDesc') }}</p>
      <p v-if="error" class="sso-gate-error">{{ error }}</p>
      <button
        class="sso-gate-btn"
        type="button"
        :disabled="loading"
        @click="onLogin"
      >
        {{ loading ? t('sso.loggingIn') : t('sso.loginButton') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAuth } from '../../composables/useAuth'
import { toast } from '../../composables/useToast'

const { t } = useI18n()
const { login, loading, error } = useAuth()

async function onLogin() {
  try {
    await login()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t('sso.loginFailed'))
  }
}
</script>

<style scoped>
.sso-gate {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary, #0f1115);
  color: var(--text-primary, #e8eaed);
}

.sso-gate-card {
  width: min(400px, 90vw);
  padding: 2rem;
  border-radius: 12px;
  background: var(--bg-secondary, #1a1d24);
  border: 1px solid var(--border-color, #2a2f3a);
  text-align: center;
}

.sso-gate-title {
  margin: 0 0 0.5rem;
  font-size: 1.35rem;
  font-weight: 600;
}

.sso-gate-desc {
  margin: 0 0 1.25rem;
  font-size: 0.9rem;
  color: var(--text-secondary, #9aa0a6);
  line-height: 1.5;
}

.sso-gate-error {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--danger, #f07178);
}

.sso-gate-btn {
  min-width: 160px;
  padding: 0.65rem 1.25rem;
  border: none;
  border-radius: 8px;
  background: var(--accent, #3b82f6);
  color: #fff;
  font-size: 0.95rem;
  cursor: pointer;
}

.sso-gate-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
