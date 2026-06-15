<script setup lang="ts">
/**
 * 产出物面板收起态 —— 锚定在聊天区右缘的窄条，点击展开面板。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PanelRightOpen } from 'lucide-vue-next'
import {
  artifactDisplayLabel,
  useAssistantArtifactStore
} from '../index'
import { getRendererIcon } from '../renderers/ui-registry'

const props = defineProps<{
  tabId: string
}>()

const emit = defineEmits<{
  expand: []
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()

const artifacts = computed(() => artifactStore.getArtifacts(props.tabId))
const activeArtifact = computed(() => artifactStore.getActiveArtifact(props.tabId))
const artifactCount = computed(() => artifacts.value.length)

const activeLabel = computed(() => {
  const active = activeArtifact.value
  if (!active) return t('canvas.emptyStateTitle')
  return artifactDisplayLabel(active, t('canvas.artifactUntitled'))
})

const railTitle = computed(() => {
  if (artifactCount.value <= 1) {
    return t('canvas.expandPanelWithTitle', { title: activeLabel.value })
  }
  return t('canvas.expandPanelWithCount', {
    title: activeLabel.value,
    count: artifactCount.value
  })
})

const activeRenderer = computed(() => activeArtifact.value?.renderer ?? null)
</script>

<template>
  <button
    type="button"
    class="artifact-panel-rail"
    :title="railTitle"
    :aria-label="railTitle"
    @click="emit('expand')"
  >
    <span class="artifact-panel-rail-icon-wrap">
      <component
        :is="getRendererIcon(activeRenderer ?? 'document')"
        :size="14"
        class="artifact-panel-rail-type-icon"
      />
      <PanelRightOpen :size="12" class="artifact-panel-rail-expand-icon" />
    </span>
    <span v-if="artifactCount > 1" class="artifact-panel-rail-badge">
      {{ artifactCount }}
    </span>
    <span class="artifact-panel-rail-label">{{ activeLabel }}</span>
  </button>
</template>

<style scoped>
.artifact-panel-rail {
  position: absolute;
  top: var(--workbench-panel-header-height, 38px);
  right: 0;
  bottom: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 28px;
  padding: 10px 0;
  border: none;
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.artifact-panel-rail:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #eee);
  border-left-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
}

.artifact-panel-rail-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.artifact-panel-rail-expand-icon {
  position: absolute;
  right: -3px;
  bottom: -3px;
  padding: 1px;
  border-radius: 3px;
  background: var(--bg-tertiary, #252525);
  color: var(--accent-primary, #89b4fa);
}

.artifact-panel-rail-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.18);
  color: var(--accent-primary, #89b4fa);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  flex-shrink: 0;
}

.artifact-panel-rail-label {
  flex: 1;
  min-height: 0;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  transform: rotate(180deg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-height: min(240px, 40vh);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  opacity: 0.85;
}
</style>
