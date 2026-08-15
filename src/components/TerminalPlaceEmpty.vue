<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Monitor, SquareTerminal } from 'lucide-vue-next'
import { isWorkbenchAvailable } from '../workbench/registry'
import { useConfigStore, type SshSession } from '../stores/config'

/** 主机网格最多铺几台，超出走「管理主机」看全部 */
const MAX_VISIBLE_HOSTS = 6

const emit = defineEmits<{
  'open-local': []
  'open-ssh': [session: SshSession]
  'manage-hosts': []
}>()

const { t } = useI18n()
const configStore = useConfigStore()

const canOpenLocal = isWorkbenchAvailable('local')
const canOpenSsh = isWorkbenchAvailable('ssh')

const hosts = computed(() =>
  [...configStore.sshSessions].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
)
const visibleHosts = computed(() => hosts.value.slice(0, MAX_VISIBLE_HOSTS))

function formatHost(session: SshSession): string {
  return `${session.username}@${session.host}:${session.port}`
}
</script>

<template>
  <div class="terminal-empty">
    <div class="terminal-empty-inner">
      <div class="hero">
        <div class="hero-icon">
          <SquareTerminal :size="30" :stroke-width="1.5" />
        </div>
        <h2 class="hero-title">{{ t('shell.emptyTerminal') }}</h2>
        <p class="hero-hint">{{ t('shell.emptyTerminalHint') }}</p>
      </div>

      <div class="action-cards">
        <div v-if="canOpenLocal" class="action-card" @click="emit('open-local')">
          <div class="card-icon local">
            <SquareTerminal :size="24" :stroke-width="1.5" />
          </div>
          <div class="card-content">
            <div class="card-title">{{ t('shell.openLocal') }}</div>
            <div class="card-desc">{{ t('shell.openLocalHint') }}</div>
          </div>
        </div>

        <div v-if="canOpenSsh" class="action-card" @click="emit('manage-hosts')">
          <div class="card-icon ssh">
            <Monitor :size="24" :stroke-width="1.5" />
          </div>
          <div class="card-content">
            <div class="card-title">{{ t('shell.newRemote') }}</div>
            <div class="card-desc">{{ t('shell.newRemoteHint') }}</div>
          </div>
        </div>
      </div>

      <div v-if="canOpenSsh && hosts.length > 0" class="hosts">
        <div class="section-header">
          <h3 class="section-title">{{ t('shell.savedHosts') }}</h3>
          <div
            v-if="hosts.length > MAX_VISIBLE_HOSTS"
            class="view-all"
            @click="emit('manage-hosts')"
          >
            {{ t('shell.manageHosts') }} →
          </div>
        </div>
        <div class="session-grid">
          <div
            v-for="session in visibleHosts"
            :key="session.id"
            class="session-item"
            @click="emit('open-ssh', session)"
          >
            <div class="session-icon">
              <Monitor :size="16" />
            </div>
            <div class="session-info">
              <div class="session-name">{{ session.name || session.host }}</div>
              <div class="session-host">{{ formatHost(session) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-empty {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  padding: clamp(32px, calc(50vh - 260px), 120px) 20px 32px;
}

.terminal-empty-inner {
  width: min(760px, 100%);
  display: flex;
  flex-direction: column;
  gap: 26px;
}

/* Hero */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.hero-icon {
  width: 60px;
  height: 60px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-local), var(--brand-local-end));
  box-shadow: 0 8px 24px rgba(var(--brand-local-rgb), 0.32);
}

.hero-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

.hero-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted, var(--text-secondary));
}

/* 与欢迎页「快速开始」同款卡片，两张并排 */
.action-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

@media (max-width: 640px) {
  .action-cards {
    grid-template-columns: 1fr;
  }
}

.action-card {
  --card-glow-rgb: var(--accent-decorative-rgb);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 150px;
  padding: 16px 12px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  text-align: center;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.3s ease,
              background 0.3s ease,
              box-shadow 0.3s ease;
}

.action-card:has(.card-icon.local) {
  --card-glow-rgb: var(--brand-local-rgb);
}

.action-card:has(.card-icon.ssh) {
  --card-glow-rgb: var(--brand-ssh-rgb);
}

/* 绕卡片外延一圈的品牌色柔光，hover 时亮起（与欢迎页一致） */
.action-card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 18px;
  background: linear-gradient(135deg,
    rgba(var(--card-glow-rgb), 1),
    rgba(var(--card-glow-rgb), 0.55));
  opacity: 0;
  z-index: -1;
  transition: opacity 0.3s ease;
}

.action-card:hover::before {
  opacity: 0.55;
}

.action-card:hover {
  transform: translateY(-3px);
  border-color: rgba(var(--card-glow-rgb), 0.55);
  background: var(--bg-tertiary, var(--bg-secondary));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

.action-card:active {
  transform: translateY(-1px);
}

.card-icon {
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  box-shadow: 0 4px 15px rgba(var(--card-glow-rgb), 0.3);
  transition: transform 0.3s ease, box-shadow 0.3s ease, filter 0.3s ease;
}

.action-card:hover .card-icon {
  transform: scale(1.05) translateY(-2px);
  filter: saturate(1.2) brightness(1.08);
  box-shadow:
    0 12px 24px rgba(var(--card-glow-rgb), 0.5),
    0 4px 10px rgba(0, 0, 0, 0.12);
}

.card-icon.local {
  background: linear-gradient(135deg, var(--brand-local), var(--brand-local-end));
}

.card-icon.ssh {
  background: linear-gradient(135deg, var(--brand-ssh), var(--brand-ssh-end));
}

.card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.card-desc {
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  line-height: 1.4;
}

/* 已存主机 */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 1px;
  opacity: 0.8;
}

.view-all {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.2s ease;
}

.view-all:hover {
  color: var(--text-primary);
  background: rgba(var(--accent-decorative-rgb), 0.1);
  transform: translateX(4px);
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

.session-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  cursor: pointer;
  overflow: hidden;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.session-item:hover {
  border-color: var(--accent-decorative-primary);
  background: var(--bg-tertiary);
  transform: translateX(4px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
}

.session-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.2), rgba(var(--accent-decorative-rgb), 0.1));
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.session-item:hover .session-icon {
  transform: scale(1.1);
  background: linear-gradient(135deg, rgba(var(--accent-decorative-rgb), 0.35), rgba(var(--accent-decorative-rgb), 0.2));
  color: var(--text-primary);
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
