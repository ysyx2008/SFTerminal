<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge）。
 * 「跳到生成处」/「引用到 Composer」经 AiPanel defineExpose，由本壳持 ref 转发。
 * Markdown 选区作用域：发送前经 consumeSelectionScope 静默附带，不进引用胶囊。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PanelRightClose, PanelRightOpen } from 'lucide-vue-next'
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
import type { ArtifactComposerQuote } from './artifact/composer-quote'
import { consumeSelectionScope } from './artifact/selection-scope'
import type { WorkbenchContext } from '@shared/types'
import { useAssistantArtifactStore } from './artifact/store'
import { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
import ArtifactPanel from './artifact/components/ArtifactPanel.vue'

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

const docExpanded = computed(() => artifactStore.isVisible(props.tab.id))
const panelMinimized = computed(() => artifactStore.isPanelMinimized(props.tab.id))
const showPanelToggle = computed(() => docExpanded.value || panelMinimized.value)
const ratio = computed({
  get: () => artifactStore.splitRatio,
  set: (v: number) => { artifactStore.splitRatio = v },
})

const panelToggleTitle = computed(() =>
  docExpanded.value ? t('canvas.minimizePanel') : t('canvas.expandPanel')
)

function togglePanel() {
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
  <div class="assistant-workbench">
    <WorkbenchShell
      :toggle-visible="docExpanded"
      v-model:toggle-ratio="ratio"
      toggle-side="right"
    >
      <template #anchor>
        <AiPanel
          ref="aiPanelRef"
          :tab-id="tab.id"
          :tab-active="isActive"
          :consume-workbench-context="consumeWorkbenchContext"
        />
      </template>
      <template #toggle>
        <ArtifactPanel
          v-if="showPanelToggle"
          ref="artifactPanelRef"
          :tab-id="tab.id"
          :scroll-to-agent-step="scrollToAgentStep"
          :add-composer-quote="addComposerQuote"
          :add-composer-image="addComposerImage"
          :set-composer-draft="setComposerDraft"
        />
      </template>
    </WorkbenchShell>
    <button
      v-if="showPanelToggle"
      type="button"
      class="artifact-toggle-btn"
      :title="panelToggleTitle"
      :aria-label="panelToggleTitle"
      :aria-expanded="docExpanded"
      @click="togglePanel"
    >
      <PanelRightClose v-if="docExpanded" :size="14" />
      <PanelRightOpen v-else :size="14" />
    </button>
  </div>
</template>

<style scoped>
.assistant-workbench {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.artifact-toggle-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
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

.artifact-toggle-btn:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text-primary);
}
</style>
