<script setup lang="ts">
/**
 * 风险策略：命令定完级之后怎么处理。
 *
 * 与「命令规则」页共用同一份策略存储——那页管的是路径分区（定级的输入），
 * 这页管的是各风险级别在不同执行模式下的处置。
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, ShieldAlert } from 'lucide-vue-next'
import { SettingsPage, SettingsGroup, SettingRow, SettingToggle, SettingHelp } from './kit'
import { useRiskPolicy, DEFAULT_POLICY } from './composables/useRiskPolicy'
import { useRiskLevelLabels, POLICY_ALLOWED_LEVELS } from './composables/useRiskLevelLabels'
import { useUnsavedGuard } from './composables/useUnsavedGuard'

type PolicyLevelField =
  | 'strictParseFail' | 'relaxedParseFail'
  | 'strictUnknownCmd' | 'relaxedUnknownCmd'
  | 'strictIndirection' | 'relaxedIndirection'
  | 'strictDynamicPath' | 'relaxedDynamicPath'

const POLICY_ROWS: Array<{ label: string; strict: PolicyLevelField; relaxed: PolicyLevelField }> = [
  { label: 'colParseFail', strict: 'strictParseFail', relaxed: 'relaxedParseFail' },
  { label: 'colUnknownCmd', strict: 'strictUnknownCmd', relaxed: 'relaxedUnknownCmd' },
  { label: 'colIndirection', strict: 'strictIndirection', relaxed: 'relaxedIndirection' },
  { label: 'colDynamicPath', strict: 'strictDynamicPath', relaxed: 'relaxedDynamicPath' },
]

const { t, tm } = useI18n()
const { riskLabel, riskClass } = useRiskLevelLabels()

const {
  policy,
  loading: policyLoading,
  saving: policySaving,
  justSaved: policySaved,
  error: policyError,
  unsaved: policyUnsaved,
  load: loadPolicy,
  save: savePolicy,
} = useRiskPolicy()

useUnsavedGuard(policyUnsaved)

/**
 * 「恢复默认」只动本页管的那几项。路径分区归「命令规则」页，
 * 在这里一并清掉的话，用户在另一页配的额外自由区会不声不响地消失。
 */
function resetPolicy() {
  policy.value = {
    ...DEFAULT_POLICY,
    outsideWritesUpgrade: policy.value.outsideWritesUpgrade,
    extraFreeDirs: [...policy.value.extraFreeDirs],
  }
}

const policyDiffersFromDefault = computed(() =>
  POLICY_ROWS.some(
    r => policy.value[r.strict] !== DEFAULT_POLICY[r.strict] ||
         policy.value[r.relaxed] !== DEFAULT_POLICY[r.relaxed],
  ) ||
  policy.value.relaxedConfirmModerate !== DEFAULT_POLICY.relaxedConfirmModerate ||
  policy.value.subAgentBlockDangerous !== DEFAULT_POLICY.subAgentBlockDangerous,
)

/** 策略场景的举例列表，没配就返回空数组 */
function policyTipExamples(label: string): string[] {
  const raw = tm(`settings.security.riskPolicy.${label}TipExamples`) as unknown
  return Array.isArray(raw) ? (raw as unknown[]).map(String) : []
}

onMounted(loadPolicy)
</script>

<template>
  <SettingsPage
    :title="t('settings.tabs.riskPolicy')"
    :desc="t('settings.security.riskPolicy.description')"
  >
    <template #actions>
      <button class="btn btn-sm" :disabled="policyLoading" :title="t('common.refresh')" @click="loadPolicy">
        <RefreshCw :size="14" :class="{ spinning: policyLoading }" />
      </button>
    </template>

    <div v-if="policyLoading" class="empty-state">
      <RefreshCw :size="20" class="spinning" />
      <span>{{ t('settings.security.builtinRules.loading') }}</span>
    </div>

    <div v-else-if="policyError" class="empty-state">
      <ShieldAlert :size="20" />
      <span>{{ t('settings.security.builtinRules.loadError') }}</span>
      <button class="btn btn-sm" @click="loadPolicy">{{ t('settings.security.builtinRules.retry') }}</button>
    </div>

    <template v-else>
      <div class="policy-grid">
        <div class="policy-row policy-row-header">
          <div class="policy-cell"></div>
          <div class="policy-cell policy-cell-head">
            <div class="policy-mode-tag mode-strict">{{ t('ai.strict') }}</div>
            <div class="policy-mode-desc">{{ t('settings.security.riskPolicy.strictDesc') }}</div>
          </div>
          <div class="policy-cell policy-cell-head">
            <div class="policy-mode-tag mode-relaxed">{{ t('ai.relaxed') }}</div>
            <div class="policy-mode-desc">{{ t('settings.security.riskPolicy.relaxedDesc') }}</div>
          </div>
        </div>

        <div v-for="row in POLICY_ROWS" :key="row.label" class="policy-row">
          <div class="policy-cell policy-cell-label">
            <span class="policy-scenario-name">{{ t(`settings.security.riskPolicy.${row.label}`) }}</span>
            <SettingHelp :title="t(`settings.security.riskPolicy.${row.label}`)">
              <p>{{ t(`settings.security.riskPolicy.${row.label}TipBody`) }}</p>
              <template v-if="policyTipExamples(row.label).length">
                <p>{{ t('settings.security.riskPolicy.tipExamplesLabel') }}</p>
                <ul class="policy-tip-examples">
                  <li v-for="ex in policyTipExamples(row.label)" :key="ex"><code>{{ ex }}</code></li>
                </ul>
              </template>
            </SettingHelp>
          </div>
          <div class="policy-cell">
            <div class="policy-radio-group" role="radiogroup">
              <label
                v-for="lvl in POLICY_ALLOWED_LEVELS"
                :key="row.strict + lvl"
                class="policy-radio"
                :class="[riskClass(lvl), { active: policy[row.strict] === lvl }]"
              >
                <input v-model="policy[row.strict]" type="radio" :value="lvl" />
                {{ riskLabel(lvl) }}
              </label>
            </div>
          </div>
          <div class="policy-cell">
            <div class="policy-radio-group" role="radiogroup">
              <label
                v-for="lvl in POLICY_ALLOWED_LEVELS"
                :key="row.relaxed + lvl"
                class="policy-radio"
                :class="[riskClass(lvl), { active: policy[row.relaxed] === lvl }]"
              >
                <input v-model="policy[row.relaxed]" type="radio" :value="lvl" />
                {{ riskLabel(lvl) }}
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="policy-actions">
        <button class="btn btn-sm" @click="resetPolicy" :disabled="!policyDiffersFromDefault">
          {{ t('settings.security.riskPolicy.reset') }}
        </button>
        <button
          class="btn btn-sm btn-primary"
          @click="savePolicy"
          :disabled="policySaving || !policyUnsaved"
        >
          {{ policySaving ? t('common.saving') : t('common.save') }}
        </button>
        <span v-if="policySaved" class="policy-saved">{{ t('settings.security.riskPolicy.saved') }}</span>
        <span v-else-if="policyUnsaved" class="policy-unsaved">{{ t('settings.security.riskPolicy.unsaved') }}</span>
      </div>

      <SettingsGroup :title="t('settings.security.riskPolicy.groupExtras')">
        <SettingRow
          clickable
          :label="t('settings.security.riskPolicy.relaxedConfirmModerate')"
          :desc="t('settings.security.riskPolicy.relaxedConfirmModerateDesc')"
        >
          <SettingToggle v-model="policy.relaxedConfirmModerate" />
        </SettingRow>
        <SettingRow
          clickable
          :label="t('settings.security.riskPolicy.subAgentBlockDangerous')"
          :desc="t('settings.security.riskPolicy.subAgentBlockDangerousDesc')"
        >
          <SettingToggle v-model="policy.subAgentBlockDangerous" />
        </SettingRow>
      </SettingsGroup>

      <p class="rule-text muted">{{ t('settings.security.riskPolicy.freeModeHint') }}</p>
      <p class="rule-text muted">{{ t('settings.security.riskPolicy.blockedHint') }}</p>
    </template>
  </SettingsPage>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px;
  color: var(--text-muted);
}

.empty-state p {
  font-size: 13px;
  margin: 0;
}

.muted {
  color: var(--text-muted);
}

.rule-text {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0 0;
  line-height: 1.5;
}

.rule-text.muted {
  color: var(--text-muted);
  font-size: 11px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* -- 命令风险策略 -- */
.policy-grid {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--border-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 12px;
}

.policy-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  background: var(--bg-secondary);
}

.policy-row-header {
  background: var(--bg-tertiary);
}

.policy-cell {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-right: 1px solid var(--border-color);
}

.policy-cell:last-child {
  border-right: none;
}

.policy-cell-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
}

.policy-cell-label {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.policy-scenario-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.policy-mode-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}

.policy-mode-tag.mode-strict {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.policy-mode-tag.mode-relaxed {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.policy-mode-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.policy-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
}

.policy-radio {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.policy-radio input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.policy-radio:hover {
  border-color: var(--text-muted);
}

.policy-radio.risk-moderate.active {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
}

.policy-radio.risk-dangerous.active {
  border-color: rgba(239, 68, 68, 0.55);
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
}

.policy-radio.risk-blocked.active {
  border-color: rgba(168, 85, 247, 0.55);
  background: rgba(168, 85, 247, 0.14);
  color: #a855f7;
}

.policy-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.policy-saved {
  font-size: 12px;
  color: #22c55e;
}

.policy-unsaved {
  font-size: 12px;
  color: var(--text-muted);
}

/* 举例是整条命令，各占一行才读得出来，帮助浮层默认的行内 code 样式在这里不够用。
   浮层虽然挂到 body，但内容由本组件渲染、带着本组件的 scope 标记，所以能命中。 */
.policy-tip-examples {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.policy-tip-examples li code {
  display: block;
  padding: var(--sp-1) var(--sp-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1.4;
  color: var(--text-primary);
  word-break: break-all;
}
</style>
