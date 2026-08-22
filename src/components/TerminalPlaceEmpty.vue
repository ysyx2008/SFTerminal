<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Monitor, Sparkles, SquareTerminal } from 'lucide-vue-next'
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
    <!-- 整块内容统一左对齐、共用一套网格边界；标题不再抢主角，让两个入口当锚点 -->
    <div class="terminal-empty-inner">
      <div class="hero">
        <h2 class="hero-title">{{ t('shell.emptyTerminal') }}</h2>
        <p class="hero-hint">{{ t('shell.emptyTerminalHint') }}</p>
      </div>

      <div class="action-cards">
        <button v-if="canOpenLocal" type="button" class="action-card" @click="emit('open-local')">
          <div class="card-icon local">
            <SquareTerminal :size="21" :stroke-width="1.6" />
          </div>
          <div class="card-title">{{ t('shell.openLocal') }}</div>
        </button>

        <button v-if="canOpenSsh" type="button" class="action-card" @click="emit('manage-hosts')">
          <div class="card-icon ssh">
            <Monitor :size="21" :stroke-width="1.6" />
          </div>
          <div class="card-title">{{ t('shell.newRemote') }}</div>
        </button>
      </div>

      <div v-if="canOpenSsh && hosts.length > 0" class="hosts">
        <div class="section-header">
          <h3 class="section-title">{{ t('shell.savedHosts') }}</h3>
          <button
            v-if="hosts.length > MAX_VISIBLE_HOSTS"
            type="button"
            class="view-all"
            @click="emit('manage-hosts')"
          >
            {{ t('shell.manageHosts') }}
            <ChevronRight :size="13" :stroke-width="2" />
          </button>
        </div>
        <div class="session-grid">
          <button
            v-for="session in visibleHosts"
            :key="session.id"
            type="button"
            class="session-item"
            @click="emit('open-ssh', session)"
          >
            <div class="session-info">
              <div class="session-name">{{ session.name || session.host }}</div>
              <div class="session-host">{{ formatHost(session) }}</div>
            </div>
          </button>
        </div>
      </div>

      <p class="secretary-note">
        <Sparkles :size="12" :stroke-width="1.75" />
        {{ t('shell.emptyTerminalSecretary') }}
      </p>
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
  /* 内容落在视觉上略高于正中的位置，底部留白是有意的呼吸区而不是"没排完" */
  padding: clamp(44px, 15vh, 132px) 24px 56px;
  background:
    radial-gradient(ellipse 130% 55% at 50% -8%, rgba(var(--accent-decorative-rgb), 0.045) 0%, transparent 62%),
    var(--bg-primary);
}

.terminal-empty-inner {
  width: min(700px, 100%);
  display: flex;
  flex-direction: column;
}

/* 标题从 26px 降到 20px：最大的字不该用来说"你什么都没有" */
.hero {
  margin-bottom: 22px;
  animation: riseIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.hero-title {
  margin: 0 0 5px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.hero-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted, var(--text-secondary));
}

/* 卡片与主机网格外边界完全对齐，gap 统一 12px，页面由一套网格统管 */
.action-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  animation: riseIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.06s both;
}

@media (max-width: 640px) {
  .action-cards {
    grid-template-columns: 1fr;
  }
}

.action-card {
  --card-glow-rgb: var(--accent-decorative-rgb);
  appearance: none;
  position: relative;
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 66px;
  padding: 13px 16px;
  border: 1px solid color-mix(in srgb, var(--border-color) 75%, transparent);
  border-radius: 14px;
  background-image: linear-gradient(
    color-mix(in srgb, var(--text-primary) 4%, var(--bg-secondary)),
    var(--bg-secondary)
  );
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.3s ease,
              box-shadow 0.3s ease;
}

.action-card:has(.card-icon.local) {
  --card-glow-rgb: var(--brand-local-rgb);
}

.action-card:has(.card-icon.ssh) {
  --card-glow-rgb: var(--brand-ssh-rgb);
}

.action-card:hover {
  transform: translateY(-2px);
  border-color: rgba(var(--card-glow-rgb), 0.42);
  box-shadow:
    0 10px 24px rgba(0, 0, 0, 0.2),
    0 4px 14px rgba(var(--card-glow-rgb), 0.13);
}

.action-card:active {
  transform: translateY(0);
}

.action-card:focus-visible,
.session-item:focus-visible,
.view-all:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

/* 全页仅剩这两枚饱和色图标，是唯一的品牌落点 */
.card-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background-image: linear-gradient(140deg, var(--card-grad-from), var(--card-grad-to));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 3px 10px rgba(var(--card-glow-rgb), 0.26);
  transition: box-shadow 0.3s ease, filter 0.3s ease;
}

.action-card:hover .card-icon {
  filter: saturate(1.08) brightness(1.04);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.24),
    0 6px 16px rgba(var(--card-glow-rgb), 0.38);
}

.card-icon.local {
  --card-grad-from: var(--brand-local);
  --card-grad-to: var(--brand-local-end);
}

.card-icon.ssh {
  --card-grad-from: var(--brand-ssh);
  --card-grad-to: var(--brand-ssh-end);
}

.card-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 最近连接 */
.hosts {
  margin-top: 26px;
  animation: riseIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.12s both;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted, var(--text-secondary));
}

.view-all {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 3px 4px 3px 7px;
  border: none;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted, var(--text-secondary));
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;
}

.view-all:hover {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

@media (max-width: 640px) {
  .session-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 上一版把描边和底色都去掉，结果 6 组文字浮在空白里像没写样式。
   这里给一层极淡的表面：静止时轻到几乎无形，但"可点"的边界是在的 */
.session-item {
  appearance: none;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease;
}

.session-item:hover {
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
  border-color: rgba(var(--brand-ssh-rgb), 0.35);
}

.session-item:active {
  background: color-mix(in srgb, var(--text-primary) 10%, transparent);
}

.session-info {
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
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted, var(--text-secondary));
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item:hover .session-host {
  color: var(--text-secondary);
}

/* 秘书的一句话：这页不只是"开终端"，开完还有人帮你干活 */
.secretary-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 26px 0 0;
  font-size: 11.5px;
  color: var(--text-muted, var(--text-secondary));
  opacity: 0.75;
  animation: riseIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.18s both;
}

.secretary-note svg {
  flex-shrink: 0;
}

@keyframes riseIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hero,
  .action-cards,
  .hosts,
  .secretary-note {
    animation: none;
  }

  .action-card:hover {
    transform: none;
  }
}
</style>
