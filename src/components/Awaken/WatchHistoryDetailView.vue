<script setup lang="ts">
/**
 * 关切 / 唤醒执行历史详情
 * 供历史 tab 与关切 tab 内叠层复用。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw } from 'lucide-vue-next'
import type { WatchHistoryRecord } from '@shared/types'
import { shouldShowToolResultStep } from '../../utils/tool-display'
import { parseThinking } from '../../utils/thinking-block'
import { useMarkdown } from '../../composables'
import ThinkingBlock from '../ThinkingBlock.vue'
import ToolCallContent from '../ToolCallContent.vue'
import { useConfigStore } from '../../stores/config'

type DetailStep = {
  id: string
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
  success?: boolean
  images?: string[]
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}

const props = defineProps<{
  record: WatchHistoryRecord
  loading: boolean
  steps: DetailStep[]
  userTask: string
  backLabel: string
}>()

const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const configStore = useConfigStore()
const { renderMarkdown, handleCodeBlockClick, handleFilePathContextMenu } = useMarkdown()

const historyPromptExpanded = ref(false)

const HIDDEN_STEP_TYPES = new Set(['user_task', 'streaming', 'waiting', 'waiting_password', 'confirm'])

function isFailureFinalResult(content: string): boolean {
  return content.startsWith('❌') || content.startsWith('⚠️')
}

function filterHistorySteps<T extends { type: string; content: string }>(
  raw: T[],
  debugMode: boolean,
): T[] {
  const steps = raw
    .filter(s => !HIDDEN_STEP_TYPES.has(s.type))
    .filter(s => shouldShowToolResultStep(s, debugMode))
  const finalResult = steps.find(s => s.type === 'final_result')
  if (!finalResult) return steps
  if (isFailureFinalResult(finalResult.content)) return steps

  const finalText = finalResult.content.trim()
  const hasDuplicateMessage = steps.some(s => {
    if (s.type !== 'message') return false
    return parseThinking(s.content).body.trim() === finalText
  })
  if (hasDuplicateMessage) {
    return steps.filter(s => s.type !== 'final_result')
  }
  return steps
}

const filteredSteps = computed(() =>
  filterHistorySteps(props.steps, configStore.agentDebugMode),
)

const getMessageStepPresentation = (step: { content: string }) => {
  const parsed = parseThinking(step.content)
  return {
    thinking: parsed.thinking
      ? { reasoning: parsed.thinking.reasoning, isStreaming: !parsed.thinking.isDone }
      : null,
    body: parsed.body,
  }
}

const expandedThinkingSteps = ref<Set<string>>(new Set())
const isThinkingExpanded = (stepId: string): boolean => expandedThinkingSteps.value.has(stepId)
const toggleThinkingExpand = (stepId: string) => {
  const next = new Set(expandedThinkingSteps.value)
  if (next.has(stepId)) next.delete(stepId)
  else next.add(stepId)
  expandedThinkingSteps.value = next
}

const formatFullDate = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`

const getStatusClass = (status: string): string => {
  const map: Record<string, string> = {
    completed: 'status-success', success: 'status-success', failed: 'status-error',
    skipped: 'status-skipped', timeout: 'status-warning', cancelled: 'status-muted', running: 'status-running',
  }
  return map[status] || ''
}
const getStatusIcon = (status: string): string => {
  const map: Record<string, string> = {
    completed: '✓', failed: '✗', skipped: '⊘', timeout: '⏱', cancelled: '—', running: '●',
  }
  return map[status] || '?'
}
const getStepIcon = (type: string): string => {
  const map: Record<string, string> = {
    thinking: '🤔', tool_call: '🔧', tool_result: '📋', message: '💬', error: '❌',
    final_result: '✅', waiting: '⏳', asking: '❓', user_task: '👤',
  }
  return map[type] || '•'
}
const formatToolResult = (result: string): string | null => {
  if (!result) return null
  const match = /<content>([\s\S]*?)<\/content>/.exec(result)
  return match ? match[1].trim() : result
}
</script>

<template>
  <div class="history-detail-view">
    <div class="page-toolbar">
      <button class="btn btn-sm back-btn" @click="emit('back')">
        ← {{ backLabel }}
      </button>
      <span class="page-title">
        <span :class="getStatusClass(record.status)">{{ getStatusIcon(record.status) }}</span>
        {{ record.watchName }}
      </span>
      <span class="history-detail-meta">
        {{ formatFullDate(record.at) }} · {{ formatDuration(record.duration) }}
      </span>
    </div>

    <div class="history-detail-content">
      <div v-if="loading" class="empty-state loading-state">
        <RefreshCw :size="24" class="spinning empty-icon" />
        <p>{{ t('watch.loadingConversation') }}</p>
      </div>

      <template v-else>
        <template v-if="filteredSteps.length > 0">
          <div v-if="userTask" class="history-prompt-section">
            <div class="prompt-toggle" @click="historyPromptExpanded = !historyPromptExpanded">
              <span class="prompt-toggle-icon">{{ historyPromptExpanded ? '▼' : '▶' }}</span>
              <span class="detail-section-label">{{ t('watch.prompt') }}</span>
            </div>
            <div v-if="historyPromptExpanded" class="history-detail-task">
              {{ userTask }}
            </div>
          </div>

          <div
            class="history-steps-list"
            @click="handleCodeBlockClick"
            @contextmenu="handleFilePathContextMenu"
          >
            <div
              v-for="step in filteredSteps"
              :key="step.id"
              class="agent-step-inline"
              :class="[step.type]"
            >
              <span class="step-icon">{{ getStepIcon(step.type) }}</span>
              <div class="step-content">
                <div v-if="step.type === 'message' || step.type === 'thinking'" class="agent-message-stack">
                  <template v-for="(pres, presIdx) in [getMessageStepPresentation(step)]" :key="presIdx">
                    <ThinkingBlock
                      v-if="pres.thinking"
                      :reasoning="pres.thinking.reasoning"
                      :is-streaming="pres.thinking.isStreaming"
                      :expanded="isThinkingExpanded(step.id)"
                      :started-at="step.timestamp"
                      @toggle="toggleThinkingExpand(step.id)"
                    />
                    <div
                      v-else-if="step.type === 'thinking' && step.content"
                      class="step-text"
                    >{{ step.content }}</div>
                    <div
                      v-if="pres.body && step.type === 'message'"
                      class="step-text step-analysis markdown-content"
                      v-html="renderMarkdown(pres.body)"
                    ></div>
                  </template>
                </div>
                <ToolCallContent
                  v-else-if="step.type === 'tool_call'"
                  :content="step.content"
                  :toolArgs="step.toolArgs"
                />
                <div
                  v-else-if="step.type === 'error'"
                  class="step-text"
                >{{ step.content }}</div>
                <div
                  v-else
                  class="step-text markdown-content"
                  v-html="renderMarkdown(step.content)"
                ></div>
                <div v-if="step.toolResult && step.toolResult !== step.content" class="step-tool-result">
                  <pre>{{ formatToolResult(step.toolResult) }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div v-if="record.output" class="history-fallback-output">
            <div class="detail-section-label">{{ t('watch.outputLabel') }}</div>
            <div class="fallback-text">{{ record.output }}</div>
          </div>
          <div v-if="!record.agentSessionId" class="history-legacy-hint">
            {{ t('watch.legacyRecordHint') }}
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.history-detail-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.page-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.back-btn { gap: 4px; }
.page-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-detail-meta {
  color: var(--text-muted);
  font-size: 12px;
  margin-left: auto;
  flex-shrink: 0;
}
.history-detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 24px 24px;
}
.loading-state { padding: 40px 20px; }
.history-prompt-section { margin: 16px 0 8px; }
.prompt-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.prompt-toggle-icon { font-size: 10px; color: var(--text-muted); }
.detail-section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.history-detail-task {
  padding: 12px 16px;
  background: var(--bg-primary, rgba(0,0,0,0.15));
  border-radius: 8px;
  margin-top: 4px;
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  color: var(--text-secondary);
}
.history-legacy-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.history-fallback-output { margin-top: 16px; }
.fallback-text {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text-secondary);
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.empty-icon { color: var(--text-muted); opacity: 0.3; }
.empty-state p { color: var(--text-muted); font-size: 13px; margin: 0; }

.status-success { color: #28a745; }
.status-error { color: #dc3545; }
.status-warning { color: #ffc107; }
.status-skipped { color: #6c757d; }
.status-muted { color: var(--text-muted); }
.status-running { color: var(--accent-primary); }

.history-steps-list { padding: 4px 0; }
.history-steps-list .agent-step-inline {
  display: flex; gap: 8px; padding: 8px 0; font-size: 12px;
  color: var(--text-secondary); border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.history-steps-list .agent-step-inline:last-child { border-bottom: none; }
.history-steps-list .step-icon { flex-shrink: 0; font-size: 14px; }
.history-steps-list .step-content { flex: 1; min-width: 0; }
.history-steps-list .step-text { word-break: break-word; line-height: 1.5; }
.history-steps-list .agent-message-stack {
  display: flex; flex-direction: column; gap: 8px;
}
.history-steps-list .agent-message-stack > .step-text.step-analysis { margin: 0; }
.history-steps-list .agent-message-stack :deep(.thinking-block) { margin: 0; }
.history-steps-list .step-text.step-analysis {
  color: var(--text-primary);
}
.history-steps-list .step-text.markdown-content :deep(p) { margin: 0.4em 0; }
.history-steps-list .step-text.markdown-content :deep(p:first-child) { margin-top: 0; }
.history-steps-list .step-text.markdown-content :deep(p:last-child) { margin-bottom: 0; }
.history-steps-list .step-text.markdown-content :deep(pre) { margin: 0.5em 0; overflow-x: auto; }
.history-steps-list .agent-step-inline.thinking { color: rgba(var(--brand-vital-rgb), 0.85); }
.history-steps-list .agent-step-inline.tool_call { color: var(--accent-primary); }
.history-steps-list .agent-step-inline.tool_call .step-text { color: var(--text-primary); white-space: pre-wrap; }
.history-steps-list .agent-step-inline.tool_result { color: var(--text-secondary); }
.history-steps-list .agent-step-inline.tool_result .step-text {
  font-size: 11px; max-height: 120px; overflow-y: auto;
  background: var(--bg-primary, rgba(0,0,0,0.1)); padding: 6px 8px; border-radius: 4px;
}
.step-tool-result {
  margin-top: 4px; font-size: 11px; max-height: 150px; overflow-y: auto;
  background: var(--bg-primary, rgba(0,0,0,0.1)); padding: 6px 8px; border-radius: 4px;
  color: var(--text-secondary);
}
.step-tool-result pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.history-steps-list .agent-step-inline.error { color: var(--color-error); }
.history-steps-list .agent-step-inline.message { color: var(--text-primary); }
.history-steps-list .agent-step-inline.final_result { color: var(--text-primary); }
.history-steps-list .agent-step-inline.final_result .step-text {
  background: rgba(40, 167, 69, 0.08); padding: 8px 12px; border-radius: 6px;
  border: 1px solid rgba(40, 167, 69, 0.2);
}

.spinning { animation: hist-spin 1s linear infinite; }
@keyframes hist-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
