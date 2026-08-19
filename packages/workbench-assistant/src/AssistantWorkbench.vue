<script setup lang="ts">
/**
 * AssistantWorkbench —— 独立助手工作台（声明式区域，走通用 WorkbenchShell）
 *
 * 锚点区 = 聊天（AiPanel，常驻）；可隐区 = 产出物面板（ArtifactPanel，按需显隐）。
 * step→产出物接线在本岗挂载（useArtifactAgentBridge）。
 * 「跳到生成处」/「引用到 Composer」经 AiPanel defineExpose，由本壳持 ref 转发。
 * Markdown 选区作用域：发送前经 consumeSelectionScope 静默附带，不进引用胶囊。
 */
import { computed, reactive, ref, watch, nextTick, onUnmounted } from 'vue'
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
const chatVisible = ref(true)
const stageResizing = ref(false)
const stageRef = ref<HTMLElement | null>(null)
const MIN_CHAT_WIDTH = 300

type DeskSeat = 'none' | 'terminal' | 'artifact'
const seat = ref<DeskSeat>('none')

const terminalSeated = computed(() => hasHostedTerminal.value && seat.value === 'terminal')
const artifactSeated = computed(() =>
  seat.value === 'artifact' && artifactStore.isVisible(props.tab.id)
)
const docExpanded = computed(() => artifactSeated.value)
const hasArtifacts = computed(() => artifactStore.hasArtifacts(props.tab.id))
const showDeskList = computed(() =>
  hasArtifacts.value || (hasHostedTerminal.value && !terminalSeated.value)
)
const showArtifactFold = computed(() => hasArtifacts.value && !terminalSeated.value)
const showDeskChrome = computed(() =>
  showDeskList.value || (showArtifactFold.value && !docExpanded.value)
)
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
const deskTerminalTitle = computed(() => {
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null
    const n = node as {
      type?: string
      terminalType?: string
      sshSessionId?: string
      sshConfig?: { username?: string; host?: string }
      isActive?: boolean
      children?: unknown[]
    }
    if (n.type === 'terminal') {
      if (n.terminalType === 'ssh') {
        if (n.sshConfig?.host) {
          return n.sshConfig.username
            ? `${n.sshConfig.username}@${n.sshConfig.host}`
            : n.sshConfig.host
        }
        return t('tabs.sshTerminal')
      }
      return t('terminal.localTerminal')
    }
    for (const child of n.children || []) {
      const title = walk(child)
      if (title) return title
    }
    return null
  }
  return walk(props.tab.splitLayout) ?? t('terminal.localTerminal')
})

watch(hasArtifacts, (has, had) => {
  if (!has) listOpen.value = false
  if (had && !has && hasHostedTerminal.value) {
    seat.value = 'terminal'
    chatVisible.value = true
    artifactStore.dismissPanel(props.tab.id)
  }
})

watch(hasHostedTerminal, (hosted, wasHosted) => {
  if (wasHosted === undefined) {
    if (hosted) {
      seat.value = 'terminal'
      artifactStore.minimizePanel(props.tab.id)
    } else if (artifactStore.isVisible(props.tab.id)) {
      seat.value = 'artifact'
    }
    return
  }
  if (hosted && !wasHosted) {
    seat.value = 'terminal'
    chatVisible.value = true
    listOpen.value = false
    artifactStore.minimizePanel(props.tab.id)
    return
  }
  if (!hosted && wasHosted && seat.value === 'terminal') {
    seat.value = 'none'
  }
}, { immediate: true })

watch(() => artifactStore.isVisible(props.tab.id), (visible) => {
  if (visible) {
    if (seat.value === 'terminal') {
      const steal = artifactStore.lastCanvasOpen
      if (steal?.tabId === props.tab.id && steal.stealSeat) {
        artifactStore.lastCanvasOpen = null
        seat.value = 'artifact'
        return
      }
      artifactStore.minimizePanel(props.tab.id)
      return
    }
    seat.value = 'artifact'
    return
  }
  if (seat.value === 'artifact') {
    seat.value = 'none'
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
      ?.addQuotedTerminalSelection?.(text, props.tab.title ?? '')
  void nextTick(() => {
    if (!addQuote()) void nextTick(addQuote)
  })
}

function toggleList() {
  listOpen.value = !listOpen.value
}

function openArtifact(artifactId: string) {
  seat.value = 'artifact'
  listOpen.value = false
  artifactStore.setActiveArtifact(props.tab.id, artifactId)
}

function seatTerminal() {
  if (!hasHostedTerminal.value) return
  seat.value = 'terminal'
  listOpen.value = false
  artifactStore.minimizePanel(props.tab.id)
}

function togglePanel() {
  if (terminalSeated.value) return
  listOpen.value = false
  if (docExpanded.value) {
    if (artifactPanelRef.value) {
      artifactPanelRef.value.minimizePanel()
    } else {
      artifactStore.minimizePanel(props.tab.id)
    }
    seat.value = 'none'
    return
  }
  seat.value = 'artifact'
  artifactStore.expandPanel(props.tab.id)
}

function toggleAiPanel() {
  if (!terminalSeated.value) return
  chatVisible.value = !chatVisible.value
}

function ensureAiPanel() {
  chatVisible.value = true
}

/** 给窗口右上折叠开关用：普通 ref 经实例取出后会丢响应，用 reactive 对象让父级跟得上 */
const deskChat = reactive({
  seated: false,
  visible: true,
})
watch(terminalSeated, (seated) => { deskChat.seated = seated }, { immediate: true })
watch(chatVisible, (visible) => { deskChat.visible = visible })

defineExpose({
  toggleAiPanel,
  ensureAiPanel,
  showAiPanel: chatVisible,
  hasDeskChatToggle: terminalSeated,
  deskChat,
})
</script>

<template>
  <div
    ref="stageRef"
    class="assistant-workbench"
    :class="{
      'is-panel-open': docExpanded,
      'is-terminal-stage': terminalSeated,
      'is-chat-collapsed': terminalSeated && !chatVisible,
      'is-stage-resizing': stageResizing,
      'has-desk-list': showDeskList,
      'has-artifact-fold': showArtifactFold && !docExpanded
    }"
  >
    <div v-if="hasHostedTerminal" v-show="terminalSeated" class="assistant-terminal">
      <TerminalPaneHost :tab="tab" :is-active="isActive" show-stage-chrome @send-to-ai="handleSendToAi" />
    </div>
    <div
      class="assistant-chat-column"
      :style="terminalSeated && chatVisible ? { width: chatWidth + 'px' } : undefined"
    >
      <div
        v-if="terminalSeated && chatVisible"
        class="stage-resizer"
        :class="{ resizing: stageResizing }"
        @mousedown="startStageResize"
      />
      <WorkbenchShell
        class="assistant-shell"
        :toggle-visible="docExpanded && hasArtifacts"
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
            <div v-if="showDeskChrome" class="artifact-chrome artifact-chrome--cluster">
              <div v-if="showDeskList" class="artifact-list-slot">
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
                    :show-terminal="hasHostedTerminal"
                    :terminal-title="deskTerminalTitle"
                    :terminal-active="terminalSeated"
                    @select="openArtifact"
                    @select-terminal="seatTerminal"
                    @close="listOpen = false"
                  />
                </Transition>
              </div>
              <button
                v-if="showArtifactFold && !docExpanded"
                type="button"
                class="artifact-chrome-btn"
                :title="panelToggleTitle"
                :aria-label="panelToggleTitle"
                :aria-expanded="docExpanded"
                @click="togglePanel"
              >
                <PanelRightOpen :size="14" />
              </button>
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
    </div>
    <div v-if="showArtifactFold && docExpanded" class="artifact-chrome artifact-chrome--fold">
      <button
        type="button"
        class="artifact-chrome-btn"
        :title="panelToggleTitle"
        :aria-label="panelToggleTitle"
        :aria-expanded="docExpanded"
        @click="togglePanel"
      >
        <PanelRightClose :size="14" />
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

.assistant-chat-column {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.assistant-workbench.is-terminal-stage .assistant-chat-column {
  flex: 0 0 auto;
  min-width: 300px;
  border-left: 1px solid var(--border-color);
  transition: width 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}

.assistant-workbench.is-terminal-stage .assistant-chat-column::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
  pointer-events: none;
}

.assistant-workbench.is-stage-resizing .assistant-chat-column {
  transition: none;
}

.assistant-workbench.is-terminal-stage.is-chat-collapsed .assistant-chat-column {
  width: 0 !important;
  min-width: 0;
  border-left: none;
  overflow: hidden;
  pointer-events: none;
}

.assistant-shell {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.stage-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
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

.artifact-chrome {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  -webkit-app-region: no-drag;
}

.artifact-list-slot {
  position: relative;
  display: flex;
  align-items: center;
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
