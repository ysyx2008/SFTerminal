<script setup lang="ts">
/**
 * 产出物面板收起态 —— 占据右侧分屏列的窄栏，点击图标或展开按钮恢复面板。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PanelRightOpen } from 'lucide-vue-next'
import type { CanvasArtifact } from '@shared/types'
import HoverTipOverlay from '../../../../components/HoverTipOverlay.vue'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../../../../composables/useHoverTip'
import {
  artifactDisplayLabel,
  sortArtifactsByRecent,
  useAssistantArtifactStore
} from '../index'
import { getRendererIcon } from '../renderers/ui-registry'

const props = defineProps<{
  tabId: string
}>()

const emit = defineEmits<{
  expand: [artifactId?: string]
}>()

const MAX_VISIBLE = 6

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()

const artifacts = computed(() => sortArtifactsByRecent(artifactStore.getArtifacts(props.tabId)))
const activeArtifactId = computed(() => artifactStore.getActiveArtifact(props.tabId)?.id ?? null)
const visibleArtifacts = computed(() => artifacts.value.slice(0, MAX_VISIBLE))
const overflowCount = computed(() => Math.max(0, artifacts.value.length - MAX_VISIBLE))

const { hoverTip, showTip, hideTip } = useHoverTip({ placement: 'left', delayMs: 0 })

function artifactLabel(artifact: CanvasArtifact) {
  return artifactDisplayLabel(artifact, t('canvas.artifactUntitled'))
}

function expand(artifactId?: string) {
  hideTip()
  emit('expand', artifactId)
}
</script>

<template>
  <div class="artifact-panel-rail">
    <div class="artifact-panel-rail-header">
      <button
        type="button"
        class="artifact-panel-rail-expand"
        :aria-label="t('canvas.expandPanel')"
        @mouseenter="showTip($event, t('canvas.expandPanel'), {
          placement: 'bottom',
          delayMs: BUTTON_HOVER_TIP_DELAY_MS
        })"
        @mouseleave="hideTip"
        @click="expand()"
      >
        <PanelRightOpen :size="15" />
      </button>
    </div>

    <div v-if="artifacts.length > 0" class="artifact-panel-rail-list" role="list">
      <button
        v-for="artifact in visibleArtifacts"
        :key="artifact.id"
        type="button"
        role="listitem"
        class="artifact-panel-rail-item"
        :class="{ active: artifact.id === activeArtifactId }"
        :aria-label="t('canvas.expandPanelWithTitle', { title: artifactLabel(artifact) })"
        @mouseenter="showTip($event, artifactLabel(artifact))"
        @mouseleave="hideTip"
        @click="expand(artifact.id)"
      >
        <span class="artifact-panel-rail-item-icon" :data-type="artifact.renderer">
          <component :is="getRendererIcon(artifact.renderer)" :size="14" />
        </span>
      </button>
      <button
        v-if="overflowCount > 0"
        type="button"
        class="artifact-panel-rail-overflow"
        :aria-label="t('canvas.expandPanelWithCount', {
          title: artifactLabel(artifacts[0]),
          count: artifacts.length
        })"
        @mouseenter="showTip($event, t('canvas.expandPanelWithCount', {
          title: artifactLabel(artifacts[0]),
          count: artifacts.length
        }), { placement: 'left', delayMs: BUTTON_HOVER_TIP_DELAY_MS })"
        @mouseleave="hideTip"
        @click="expand()"
      >
        +{{ overflowCount }}
      </button>
    </div>

    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.artifact-panel-rail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg-primary, #1e1e1e);
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.artifact-panel-rail-header {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
}

.artifact-panel-rail-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.artifact-panel-rail-expand:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--accent-primary, #89b4fa);
}

.artifact-panel-rail-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-height: 0;
  padding: 8px 0;
  overflow-y: auto;
}

.artifact-panel-rail-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s;
}

.artifact-panel-rail-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
}

.artifact-panel-rail-item.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
}

.artifact-panel-rail-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-secondary, #aaa);
}

.artifact-panel-rail-item.active .artifact-panel-rail-item-icon {
  color: var(--accent-primary, #89b4fa);
}

.artifact-panel-rail-item-icon[data-type="markdown"] { color: #89b4fa; }
.artifact-panel-rail-item-icon[data-type="html"] { color: #fab387; }
.artifact-panel-rail-item-icon[data-type="spreadsheet"] { color: #a6e3a1; }
.artifact-panel-rail-item-icon[data-type="document"] { color: #cba6f7; }
.artifact-panel-rail-item-icon[data-type="pdf"] { color: #f38ba8; }
.artifact-panel-rail-item-icon[data-type="image"] { color: #f9e2af; }
.artifact-panel-rail-item-icon[data-type="browser"] { color: #94e2d5; }

.artifact-panel-rail-overflow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary, #888);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s, color 0.12s;
}

.artifact-panel-rail-overflow:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #eee);
}
</style>
