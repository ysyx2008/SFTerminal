<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge）。
 * 「跳到生成处」/「引用到 Composer」经 AiPanel defineExpose，由本壳持 ref 转发。
 * Markdown 选区作用域：发送前经 consumeSelectionScope 静默附带，不进引用胶囊。
 */
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { List, PanelRightClose, PanelRightOpen } from 'lucide-vue-next'
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
import { TerminalPaneHost } from '@sailfish/workbench-sdk/terminal-pane-host'
import type { ArtifactComposerQuote } from './artifact/composer-quote'
import { consumeSelectionScope } from './artifact/selection-scope'
import type { WorkbenchContext } from '@shared/types'
import { useAssistantArtifactStore } from './artifact/store'
import { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
import ArtifactPanel from './artifact/components/ArtifactPanel.vue'
import ArtifactListPopover from './artifact/components/ArtifactListPopover.vue'

const props = defineProps<WorkbenchRendererProps>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
useArtifactAgentBridge(() => props.tab.id)

/** AiPanel 对外接口（defineExpose） */
const aiPanelRef = ref<{
  scrollToAgentStep: (stepId: string) => void | Promise<void>
  addComposerQuote: (snippet: ArtifactComposerQuote) => void
  addComposerImage: (image: { dataUrl: string; name: string; width?: number; height?: number }) => void
  setComposerDraft: (text: string) => void
} | null>(null)

const artifactPanelRef = ref<{ minimizePanel: () => void } | null>(null)

function scrollToAgentStep(stepId: string) {
  void aiPanelRef.value?.scrollToAgentStep(stepId)
}

function addComposerQuote(snippet: ArtifactComposerQuote) {
  aiPanelRef.value?.addComposerQuote(snippet)
}

function addComposerImage(image: { dataUrl: string; name: string; width?: number; height?: number }) {
  aiPanelRef.value?.addComposerImage(image)
}

function setComposerDraft(text: string) {
  aiPanelRef.value?.setComposerDraft(text)
}

/** 发送时静默取出 Markdown 选区作用域（取出即清除 sticky；不上聊天气泡） */
function consumeWorkbenchContext(): WorkbenchContext | undefined {
  const scope = consumeSelectionScope(props.tab.id)
  if (!scope?.excerpt.trim()) return undefined
  return {
    selectionScope: {
      label: scope.label,
      sourcePath: scope.sourcePath,
      sourceLinesAccurate: scope.sourceLinesAccurate,
      startLine: scope.startLine,
      endLine: scope.endLine,
      excerpt: scope.excerpt
    }
  }
}

function hostedTerminalCount(tab: { splitLayout?: unknown }): number {
  const walk = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0
    const n = node as { type?: string; ptyId?: string; children?: unknown[] }
    if (n.type === 'terminal' && n.ptyId) return 1
    return (n.children || []).reduce((sum: number, c) => sum + walk(c), 0)
  }
  return walk(tab.splitLayout)
}

const hasHostedTerminal = computed(() => hostedTerminalCount(props.tab) > 0)
const chatWidth = ref(420)
const stageResizing = ref(false)
const stageRef = ref<HTMLElement | null>(null)
const MIN_CHAT_WIDTH = 300

const docExpanded = computed(() =>
  !hasHostedTerminal.value && artifactStore.isVisible(props.tab.id)
)
const hasArtifacts = computed(() => artifactStore.hasArtifacts(props.tab.id))
const ratio = computed({
  get: () => artifactStore.splitRatio,
  set: (v: number) => { artifactStore.splitRatio = v },
})

const panelToggleTitle = computed(() =>
  docExpanded.value ? t('canvas.minimizePanel') : t('canvas.expandPanel')
)
const listOpen = ref(false)
const artifacts = computed(() => artifactStore.getArtifacts(props.tab.id))
const activeArtifactId = computed(() => artifactStore.getActiveArtifact(props.tab.id)?.id ?? null)

watch(hasArtifacts, (has) => {
  if (!has) listOpen.value = false
})

watch(hasHostedTerminal, (hosted) => {
  if (hosted) {
    listOpen.value = false
    artifactStore.minimizePanel(props.tab.id)
  }
})

function startStageResize(e: MouseEvent) {
  if (e.button !== 0) return
  stageResizing.value = true
  document.addEventListener('mousemove', onStageResize)
  document.addEventListener('mouseup', stopStageResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onStageResize(e: MouseEvent) {
  if (!stageResizing.value) return
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect) return
  const next = rect.right - e.clientX
  const max = Math.max(MIN_CHAT_WIDTH, rect.width - 240)
  if (next >= MIN_CHAT_WIDTH && next <= max) chatWidth.value = next
}

function stopStageResize() {
  stageResizing.value = false
  document.removeEventListener('mousemove', onStageResize)
  document.removeEventListener('mouseup', stopStageResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  stopStageResize()
})

function handleSendToAi(text: string) {
  const addQuote = () =>
    (aiPanelRef.value as { addQuotedTerminalSelection?: (t: string, title: string) => boolean } | null)
      ?.addQuotedTerminalSelection?.(text, props.tab.title)
  void nextTick(() => {
    if (!addQuote()) void nextTick(addQuote)
  })
}

function toggleList() {
  listOpen.value = !listOpen.value
}

function openArtifact(artifactId: string) {
  if (hasHostedTerminal.value) return
  artifactStore.setActiveArtifact(props.tab.id, artifactId)
}

function togglePanel() {
  if (hasHostedTerminal.value) return
  listOpen.value = false
  if (docExpanded.value) {
    if (artifactPanelRef.value) {
      artifactPanelRef.value.minimizePanel()
    } else {
      artifactStore.minimizePanel(props.tab.id)
    }
    return
  }
  artifactStore.expandPanel(props.tab.id)
}
</script>

<template>
  <div
    ref="stageRef"
    class="assistant-workbench"
    :class="{
      'is-panel-open': docExpanded,
      'is-terminal-stage': hasHostedTerminal,
      'is-stage-resizing': stageResizing
    }"
  >
    <div v-if="hasHostedTerminal" class="assistant-terminal">
      <TerminalPaneHost :tab="tab" :is-active="isActive" show-stage-chrome @send-to-ai="handleSendToAi" />
    </div>
    <div
      v-if="hasHostedTerminal"
      class="stage-resizer"
      :class="{ resizing: stageResizing }"
      @mousedown="startStageResize"
    />
    <WorkbenchShell
      class="assistant-shell"
      :style="hasHostedTerminal ? { width: chatWidth + 'px' } : undefined"
      :toggle-visible="docExpanded"
      v-model:toggle-ratio="ratio"
      toggle-side="right"
    >
      <template #anchor>
        <div class="assistant-chat">
          <AiPanel
            ref="aiPanelRef"
            :tab-id="tab.id"
            :tab-active="isActive"
            :consume-workbench-context="consumeWorkbenchContext"
          />
          <div v-if="hasArtifacts" class="artifact-list-chrome">
            <button
              type="button"
              class="artifact-chrome-btn"
              :class="{ 'is-open': listOpen }"
              :title="t('canvas.artifactList')"
              :aria-label="t('canvas.artifactList')"
              :aria-expanded="listOpen"
              @click="toggleList"
            >
              <List :size="14" />
            </button>
            <Transition name="artifact-list-pop">
              <ArtifactListPopover
                v-if="listOpen"
                :artifacts="artifacts"
                :active-artifact-id="activeArtifactId"
                @select="openArtifact"
                @close="listOpen = false"
              />
            </Transition>
          </div>
        </div>
      </template>
      <template #toggle>
        <ArtifactPanel
          v-if="hasArtifacts"
          ref="artifactPanelRef"
          :tab-id="tab.id"
          :scroll-to-agent-step="scrollToAgentStep"
          :add-composer-quote="addComposerQuote"
          :add-composer-image="addComposerImage"
          :set-composer-draft="setComposerDraft"
        />
      </template>
    </WorkbenchShell>
    <div v-if="hasArtifacts && !hasHostedTerminal" class="artifact-fold-chrome">
      <button
        type="button"
        class="artifact-chrome-btn"
        :title="panelToggleTitle"
        :aria-label="panelToggleTitle"
        :aria-expanded="docExpanded"
        @click="togglePanel"
      >
        <PanelRightClose v-if="docExpanded" :size="14" />
        <PanelRightOpen v-else :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.assistant-workbench {
  position: relative;
  display: flex;
  flex-direction: row;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  --workbench-panel-header-height: 38px;
}

.assistant-terminal {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-shell {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.assistant-workbench.is-terminal-stage .assistant-shell {
  flex: 0 0 auto;
  min-width: 300px;
  transition: width 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}

.assistant-workbench.is-stage-resizing .assistant-shell {
  transition: none;
}

.stage-resizer {
  flex: 0 0 5px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 5;
}

.stage-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.stage-resizer:hover::after,
.stage-resizer.resizing::after {
  opacity: 1;
}

.assistant-chat {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  container-type: inline-size;
  container-name: assistant-chat;
}

.artifact-list-chrome,
.artifact-fold-chrome {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.assistant-workbench:not(.is-panel-open) .artifact-list-chrome {
  right: 34px;
}

.artifact-chrome-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.artifact-chrome-btn:hover,
.artifact-chrome-btn.is-open {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text-primary);
}

.artifact-list-pop-enter-active {
  animation: artifact-list-pop-in 0.52s cubic-bezier(0.16, 1.42, 0.28, 1) both;
}

.artifact-list-pop-leave-active {
  animation: artifact-list-pop-out 0.2s cubic-bezier(0.4, 0, 0.72, 0.2) both;
}

@keyframes artifact-list-pop-in {
  0% {
    opacity: 0;
    transform: translateY(-10px) scale(0.9);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes artifact-list-pop-out {
  0% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  100% {
    opacity: 0;
    transform: translateY(-6px) scale(0.94);
  }
}
</style>
