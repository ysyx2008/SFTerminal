<script setup lang="ts">
/**
 * 钉在对话区右上的产出物清单小面板。点选一项即打开产出物面板并显示该项。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal, X } from 'lucide-vue-next'
import type { CanvasArtifact } from '@shared/types'
import { artifactDisplayLabel, sortArtifactsByRecent } from '../index'
import ArtifactFileIcon from './ArtifactFileIcon.vue'

const props = defineProps<{
  artifacts: readonly CanvasArtifact[]
  activeArtifactId: string | null
  showTerminal?: boolean
  terminalTitle?: string
  terminalActive?: boolean
}>()

const emit = defineEmits<{
  select: [artifactId: string]
  selectTerminal: []
  remove: [artifactId: string]
  close: []
}>()

const { t } = useI18n()

const items = computed(() => sortArtifactsByRecent(props.artifacts))

function labelOf(artifact: CanvasArtifact) {
  return artifactDisplayLabel(artifact, t('canvas.artifactUntitled'))
}

function onSelect(id: string) {
  emit('select', id)
  emit('close')
}

function onSelectTerminal() {
  emit('selectTerminal')
  emit('close')
}

function onRemove(id: string, e: Event) {
  e.stopPropagation()
  emit('remove', id)
}

function onDocMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('.artifact-chrome')) return
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="artifact-list-pop" role="menu" :aria-label="t('canvas.artifactListTitle')">
    <div class="artifact-list-pop-head">{{ t('canvas.artifactListTitle') }}</div>
    <div class="artifact-list-pop-body">
      <button
        v-if="showTerminal"
        type="button"
        role="menuitem"
        class="artifact-list-pop-item"
        :class="{ active: terminalActive }"
        :title="terminalTitle"
        @click="onSelectTerminal"
      >
        <span class="artifact-list-pop-icon">
          <Terminal :size="16" />
        </span>
        <span class="artifact-list-pop-name">{{ terminalTitle }}</span>
      </button>
      <div
        v-for="artifact in items"
        :key="artifact.id"
        role="menuitem"
        class="artifact-list-pop-item"
        :class="{ active: !terminalActive && artifact.id === activeArtifactId }"
        :title="labelOf(artifact)"
        @click="onSelect(artifact.id)"
      >
        <span class="artifact-list-pop-icon">
          <ArtifactFileIcon
            :file-path="artifact.filePath"
            :renderer="artifact.renderer"
            :size="20"
          />
        </span>
        <span class="artifact-list-pop-name">{{ labelOf(artifact) }}</span>
        <button
          type="button"
          class="artifact-list-pop-remove"
          :title="t('canvas.removeFromList')"
          @click="onRemove(artifact.id, $event)"
        >
          <X :size="12" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.artifact-list-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  box-sizing: border-box;
  width: max-content;
  min-width: 240px;
  max-width: min(560px, calc(100cqi - 16px));
  padding: 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: var(--bg-secondary, #252525);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.28);
  transform-origin: top right;
  -webkit-app-region: no-drag;
}

.artifact-list-pop-head {
  padding: 6px 8px 8px;
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.artifact-list-pop-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(360px, 50vh);
  overflow-y: auto;
}

.artifact-list-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 13px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.artifact-list-pop-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.07));
}

.artifact-list-pop-item.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.artifact-list-pop-item.active .artifact-list-pop-name {
  color: var(--accent-primary, #89b4fa);
}

.artifact-list-pop-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
}

.artifact-list-pop-name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-list-pop-remove {
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary, #888);
  cursor: pointer;
  flex-shrink: 0;
}

.artifact-list-pop-item:hover .artifact-list-pop-remove {
  display: inline-flex;
}

.artifact-list-pop-remove:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.12));
  color: var(--text-primary, #eee);
}
</style>
