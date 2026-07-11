<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Shuffle } from 'lucide-vue-next'
import {
  getFeaturedExamples,
  shuffleExamples as shuffleExamplePool,
  type AssistantExample,
} from '../config/assistantExamples'
import type { ExecutionMode, AgentHistorySummary } from '@shared/types'

defineProps<{
  isStandaloneAssistant: boolean
  isCompanionTab: boolean
  executionMode: ExecutionMode
  recentHistory: AgentHistorySummary[]
  isLoadingHistory: boolean
  formatHistoryTime: (ts: number) => string
  resolveTitle: (record: { id: string; userTask: string }) => string
}>()

const emit = defineEmits<{
  'select-scenario': [prompt: string]
  'load-history': [record: AgentHistorySummary]
  'open-history-modal': []
}>()

const { t } = useI18n()

const displayedExamples = ref<AssistantExample[]>(getFeaturedExamples())
const shuffleSpinning = ref(false)
const shuffleScenarios = () => {
  const currentIds = displayedExamples.value.map(e => e.id)
  displayedExamples.value = shuffleExamplePool(currentIds)
  shuffleSpinning.value = false
  nextTick(() => {
    shuffleSpinning.value = true
    setTimeout(() => { shuffleSpinning.value = false }, 600)
  })
}
const handleScenarioClick = (example: AssistantExample) => {
  const prompt = t(`ai.agentWelcome.scenarios.${example.id}.prompt`)
  emit('select-scenario', prompt)
}

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}
</script>

<template>
  <div class="ai-welcome">
    <!-- 联络（companion）tab 专属说明 -->
    <template v-if="isCompanionTab">
      <div class="companion-hero">
        <div class="companion-hero-icon">🤝</div>
        <div class="companion-hero-text">
          <h2 class="companion-hero-title">{{ t('ai.companionWelcome.title') }}</h2>
          <p class="companion-hero-subtitle">{{ t('ai.companionWelcome.subtitle') }}</p>
        </div>
      </div>
      <p class="companion-desc">{{ t('ai.companionWelcome.desc') }}</p>

      <p class="welcome-section-title">{{ t('ai.companionWelcome.featuresTitle') }}</p>
      <div class="companion-feature-grid">
        <div class="companion-feature-card">
          <span class="companion-feature-icon">{{ t('ai.companionWelcome.features.multiChannel.icon') }}</span>
          <span class="companion-feature-title">{{ t('ai.companionWelcome.features.multiChannel.title') }}</span>
          <span class="companion-feature-desc">{{ t('ai.companionWelcome.features.multiChannel.desc') }}</span>
        </div>
        <div class="companion-feature-card">
          <span class="companion-feature-icon">{{ t('ai.companionWelcome.features.proactive.icon') }}</span>
          <span class="companion-feature-title">{{ t('ai.companionWelcome.features.proactive.title') }}</span>
          <span class="companion-feature-desc">{{ t('ai.companionWelcome.features.proactive.desc') }}</span>
        </div>
        <div class="companion-feature-card">
          <span class="companion-feature-icon">{{ t('ai.companionWelcome.features.continuous.icon') }}</span>
          <span class="companion-feature-title">{{ t('ai.companionWelcome.features.continuous.title') }}</span>
          <span class="companion-feature-desc">{{ t('ai.companionWelcome.features.continuous.desc') }}</span>
        </div>
      </div>

      <p class="welcome-section-title">{{ t('ai.companionWelcome.examplesTitle') }}</p>
      <div class="companion-examples">
        <button
          v-for="key in (['ask', 'chat', 'followup', 'brief'] as const)"
          :key="key"
          class="companion-example-chip"
          :title="t(`ai.companionWelcome.examples.${key}.prompt`)"
          @click="emit('select-scenario', t(`ai.companionWelcome.examples.${key}.prompt`))"
        >
          <span class="companion-example-label">{{ t(`ai.companionWelcome.examples.${key}.label`) }}</span>
        </button>
      </div>

      <p class="companion-hint">{{ t('ai.companionWelcome.hint') }}</p>
    </template>

    <!-- 独立助手 / 终端模式：原有欢迎内容 -->
    <template v-else>
    <p>🤖 {{ t('ai.agentWelcome.enabled') }}</p>

    <p class="welcome-section-title">💡 {{ t('ai.agentWelcome.whatIsAgent') }}</p>
    <p class="welcome-desc">{{ isStandaloneAssistant ? t('ai.agentWelcome.standaloneDesc') : t('ai.agentWelcome.agentDesc') }}</p>

    <template v-if="isStandaloneAssistant">
      <div class="scenarios-header">
        <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
        <button
          class="shuffle-btn"
          :class="{ spinning: shuffleSpinning }"
          :title="t('ai.agentWelcome.shuffleTooltip')"
          @click="shuffleScenarios"
        >
          <Shuffle :size="13" />
          <span>{{ t('ai.agentWelcome.shuffleExamples') }}</span>
        </button>
      </div>
      <p class="scenarios-hint">{{ t('ai.agentWelcome.examplesHint') }}</p>
      <div class="scenario-grid">
        <button
          v-for="example in displayedExamples"
          :key="example.id"
          class="scenario-card"
          :data-category="example.category"
          :title="t(`ai.agentWelcome.scenarios.${example.id}.prompt`)"
          @click="handleScenarioClick(example)"
        >
          <span class="scenario-icon">{{ example.icon }}</span>
          <span class="scenario-title">{{ t(`ai.agentWelcome.scenarios.${example.id}.title`) }}</span>
          <span class="scenario-subtitle">{{ t(`ai.agentWelcome.scenarios.${example.id}.subtitle`) }}</span>
        </button>
      </div>
    </template>

    <template v-else>
      <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
      <ul>
        <li>{{ t('ai.agentWelcome.example1') }}</li>
        <li>{{ t('ai.agentWelcome.example2') }}</li>
        <li>{{ t('ai.agentWelcome.example3') }}</li>
        <li>{{ t('ai.agentWelcome.example4') }}</li>
      </ul>
    </template>

    <p class="welcome-section-title">
      <template v-if="executionMode === 'free'">🔥 {{ t('ai.agentWelcome.freeMode') }} <span class="strict-badge free">{{ t('ai.agentWelcome.freeModeOn') }}</span></template>
      <template v-else-if="executionMode === 'strict'">🔒 {{ t('ai.agentWelcome.strictMode') }} <span class="strict-badge">{{ t('ai.agentWelcome.strictModeOn') }}</span></template>
      <template v-else>🔓 {{ t('ai.agentWelcome.relaxedMode') }} <span class="strict-badge relaxed">{{ t('ai.agentWelcome.relaxedModeOn') }}</span></template>
    </p>
    <ul>
      <li v-if="executionMode === 'free'"><strong class="warning-text">{{ t('ai.agentWelcome.freeModeDesc1') }}</strong></li>
      <li v-if="executionMode === 'free'">{{ t('ai.agentWelcome.freeModeDesc2') }}</li>
      <li v-if="executionMode === 'strict'"><strong>{{ t('ai.agentWelcome.strictModeDesc1') }}</strong></li>
      <li v-if="executionMode === 'strict'">{{ t('ai.agentWelcome.strictModeDesc2') }}</li>
      <li v-if="executionMode === 'relaxed'"><strong>{{ t('ai.agentWelcome.relaxedModeDesc1') }}</strong></li>
      <li v-if="executionMode === 'relaxed'">{{ t('ai.agentWelcome.relaxedModeDesc2') }}</li>
      <li>{{ isStandaloneAssistant ? t('ai.agentWelcome.standaloneAllCommandsVisible') : t('ai.agentWelcome.allCommandsVisible') }}</li>
    </ul>

    <p class="welcome-section-title">⚠️ {{ t('ai.agentWelcome.cautions') }}</p>
    <ul v-if="isStandaloneAssistant">
      <li>{{ t('ai.agentWelcome.standaloneCaution1') }}</li>
      <li>{{ t('ai.agentWelcome.standaloneCaution2') }}</li>
    </ul>
    <ul v-else>
      <li>{{ t('ai.agentWelcome.caution1') }}</li>
      <li>{{ t('ai.agentWelcome.caution2') }}</li>
    </ul>

    <div class="recent-history-section">
      <p class="welcome-section-title">📜 {{ t('ai.agentWelcome.recentHistory') }}</p>
      <div v-if="isLoadingHistory" class="history-loading">
        {{ t('ai.agentWelcome.historyLoading') }}
      </div>
      <div v-else-if="recentHistory.length === 0" class="history-empty">
        {{ t('ai.agentWelcome.noRecentHistory') }}
      </div>
      <div v-else class="history-list">
        <div
          v-for="record in recentHistory"
          :key="record.id"
          class="history-card"
          @click="emit('load-history', record)"
        >
          <span class="history-status-icon" :class="record.status">
            {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
          </span>
          <span class="history-task">{{ truncateText(resolveTitle(record), 50) }}</span>
          <span class="history-meta">
            <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
            <span class="history-time">{{ formatHistoryTime(record.timestamp + record.duration) }}</span>
          </span>
        </div>
      </div>
      <button
        v-if="recentHistory.length > 0"
        class="view-more-btn"
        @click="emit('open-history-modal')"
      >
        {{ t('ai.agentWelcome.viewMoreHistory') }}
      </button>
    </div>
    </template>
  </div>
</template>

<style scoped>
.ai-welcome {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.ai-welcome .welcome-section-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 10px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-welcome .welcome-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

.ai-welcome ul {
  margin: 4px 0 6px;
  padding-left: 16px;
}

.ai-welcome li {
  margin: 2px 0;
  color: var(--text-muted);
  font-size: 11px;
}

.ai-welcome li strong {
  color: var(--accent-primary);
  font-weight: 500;
}

.strict-badge {
  display: inline-block;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 500;
  background: var(--accent-primary);
  color: #fff;
  border-radius: 4px;
  margin-left: 6px;
}

.strict-badge.relaxed {
  background: var(--brand-vital);
}

.strict-badge.free {
  background: var(--color-error);
}

.scenarios-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  margin-bottom: 4px;
}

.scenarios-header .welcome-section-title {
  margin: 0;
}

.shuffle-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  flex-shrink: 0;
}

.shuffle-btn:hover {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-decorative-primary) 60%, var(--border-color));
  background: color-mix(in srgb, var(--accent-decorative-primary) 8%, transparent);
}

.shuffle-btn:active {
  transform: scale(0.96);
}

.shuffle-btn :deep(svg) {
  transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}

.shuffle-btn:hover :deep(svg),
.shuffle-btn.spinning :deep(svg) {
  transform: rotate(360deg);
}

.scenarios-hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.scenario-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 6px;
}

@media (min-width: 760px) {
  .scenario-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

@media (min-width: 520px) and (max-width: 759px) {
  .scenario-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.scenario-card {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  grid-template-areas:
    "icon title"
    "icon subtitle";
  align-items: center;
  gap: 0 10px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.2s ease,
              background 0.2s ease;
  position: relative;
  overflow: hidden;
  min-height: 52px;
}

.scenario-card:hover {
  border-color: color-mix(in srgb, var(--accent-decorative-primary) 55%, var(--border-color));
  background: color-mix(in srgb, var(--accent-decorative-primary) 6%, transparent);
  transform: translateY(-1px);
}

.scenario-card:active {
  transform: translateY(0);
}

.scenario-icon {
  grid-area: icon;
  font-size: 20px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.scenario-title {
  grid-area: title;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  align-self: end;
  margin-bottom: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scenario-subtitle {
  grid-area: subtitle;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
  align-self: start;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-history-section {
  margin-top: 20px;
  padding: 16px;
  background: linear-gradient(135deg, var(--bg-tertiary) 0%, transparent 100%);
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
}

.recent-history-section .welcome-section-title {
  margin-bottom: 14px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.history-loading,
.history-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  background: var(--bg-surface);
  border-radius: 8px;
  border: 1px dashed var(--border-color);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.history-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent-primary);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.history-card:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--accent-primary) 30%, transparent);
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.history-card:hover::before {
  opacity: 1;
}

.history-card:active {
  transform: translateX(2px) scale(0.99);
}

.history-status-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  transition: transform 0.2s ease;
}

.history-card:hover .history-status-icon {
  transform: scale(1.1);
}

.history-status-icon.completed {
  background: linear-gradient(135deg, rgba(var(--brand-vital-rgb), 0.2) 0%, rgba(var(--brand-vital-rgb), 0.1) 100%);
  color: var(--brand-vital);
  box-shadow: 0 0 0 1px rgba(var(--brand-vital-rgb), 0.3);
}

.history-status-icon.failed {
  background: linear-gradient(135deg, rgba(var(--color-error-rgb), 0.2) 0%, rgba(var(--color-error-rgb), 0.1) 100%);
  color: var(--color-error);
  box-shadow: 0 0 0 1px rgba(var(--color-error-rgb), 0.3);
}

.history-status-icon.aborted {
  background: linear-gradient(135deg, rgba(var(--color-warning-rgb), 0.2) 0%, rgba(var(--color-warning-rgb), 0.1) 100%);
  color: var(--color-warning);
  box-shadow: 0 0 0 1px rgba(var(--color-warning-rgb), 0.3);
}

.history-task {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 450;
  letter-spacing: 0.1px;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.history-ssh {
  font-size: 10px;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.history-time {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.view-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.view-more-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.view-more-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-primary) 20%, transparent);
}

.view-more-btn:hover::before {
  opacity: 0.08;
}

.view-more-btn:active {
  transform: translateY(0);
}

.warning-text {
  color: var(--color-error);
}

/* ==================== 联络（companion）专属说明 ==================== */

.companion-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 14%, transparent) 0%, transparent 100%);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
  border-radius: 14px;
}

.companion-hero-icon {
  font-size: 32px;
  line-height: 1;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface));
  border-radius: 12px;
}

.companion-hero-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.companion-hero-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.companion-hero-subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.3;
}

.companion-desc {
  margin: 12px 0 16px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}

.companion-feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}

@media (max-width: 560px) {
  .companion-feature-grid {
    grid-template-columns: 1fr;
  }
}

.companion-feature-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--bg-surface);
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
  border-radius: 10px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.companion-feature-card:hover {
  border-color: color-mix(in srgb, var(--accent-decorative-primary) 45%, var(--border-color));
  background: color-mix(in srgb, var(--accent-decorative-primary) 4%, var(--bg-surface));
}

.companion-feature-icon {
  font-size: 18px;
  line-height: 1;
}

.companion-feature-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.companion-feature-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.companion-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.companion-example-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.companion-example-chip:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 6%, var(--bg-surface));
  transform: translateY(-1px);
}

.companion-example-chip:active {
  transform: translateY(0);
}

.companion-hint {
  margin-top: 8px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 11.5px;
  text-align: center;
  line-height: 1.5;
}
</style>
