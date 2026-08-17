<script setup lang="ts">
/**
 * 钉在对话区右上的产出物清单小面板。点选一项即打开产出物面板并显示该项。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasArtifact } from '@shared/types'
import { artifactDisplayLabel, sortArtifactsByRecent } from '../index'
import { getRendererIcon } from '../renderers/ui-registry'

const props = defineProps<{
  artifacts: readonly CanvasArtifact[]
  activeArtifactId: string | null
}>()

const emit = defineEmits<{
  select: [artifactId: string]
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

function onDocMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('.artifact-list-chrome')) return
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
        v-for="artifact in items"
        :key="artifact.id"
        type="button"
        role="menuitem"
        class="artifact-list-pop-item"
        :class="{ active: artifact.id === activeArtifactId }"
        :title="labelOf(artifact)"
        @click="onSelect(artifact.id)"
      >
        <span class="artifact-list-pop-icon" :data-type="artifact.renderer">
          <component :is="getRendererIcon(artifact.renderer)" :size="14" />
        </span>
        <span class="artifact-list-pop-name">{{ labelOf(artifact) }}</span>
      </button>
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
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary, #aaa);
}

.artifact-list-pop-icon[data-type="markdown"] { background: rgba(137, 180, 250, 0.14); color: #89b4fa; }
.artifact-list-pop-icon[data-type="html"] { background: rgba(250, 179, 135, 0.14); color: #fab387; }
.artifact-list-pop-icon[data-type="spreadsheet"] { background: rgba(166, 227, 161, 0.14); color: #a6e3a1; }
.artifact-list-pop-icon[data-type="document"] { background: rgba(203, 166, 247, 0.14); color: #cba6f7; }
.artifact-list-pop-icon[data-type="pdf"] { background: rgba(243, 139, 168, 0.14); color: #f38ba8; }
.artifact-list-pop-icon[data-type="image"] { background: rgba(249, 226, 175, 0.14); color: #f9e2af; }
.artifact-list-pop-icon[data-type="browser"] { background: rgba(148, 226, 213, 0.14); color: #94e2d5; }

.artifact-list-pop-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
