<script setup lang="ts">
/**
 * 聊天附件右键菜单
 *
 * 触发：父组件 @contextmenu → 传 show/x/y/filename/filePath。
 * 行为对齐 ImageContextMenu：打开 / 打开所在目录 / 复制路径 / 复制文件名 / 另存为。
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { File, FolderOpen, Copy, Download } from 'lucide-vue-next'
import { useAttachmentActions } from '../composables/useAttachmentActions'

const { t } = useI18n()
const { openAttachment, showInFolder, copyPath, copyFilename, saveAs } = useAttachmentActions()

const props = defineProps<{
  show: boolean
  x: number
  y: number
  filename: string | null
  filePath: string | null
}>()

const emit = defineEmits<{
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
const adjustedPosition = ref({ x: 0, y: 0 })

const target = computed(() => ({
  filename: props.filename || '',
  filePath: props.filePath || undefined,
}))

const hasPath = computed(() => Boolean(props.filePath))

watch([() => props.show, () => props.x, () => props.y], () => {
  if (!props.show) return
  setTimeout(() => {
    if (!menuRef.value) return
    const rect = menuRef.value.getBoundingClientRect()
    let x = props.x
    let y = props.y
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 10
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 10
    adjustedPosition.value = { x: Math.max(8, x), y: Math.max(8, y) }
  }, 0)
}, { immediate: true })

const handleClickOutside = (e: MouseEvent) => {
  if (!props.show) return
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (!props.show) return
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('contextmenu', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('contextmenu', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})

const run = async (action: () => Promise<void>) => {
  emit('close')
  try {
    await action()
  } catch {
    /* toast 已显示 */
  }
}

const handleOpen = () => run(() => openAttachment(target.value))
const handleShowInFolder = () => run(() => showInFolder(target.value))
const handleCopyPath = () => run(() => copyPath(target.value))
const handleCopyFilename = () => run(() => copyFilename(target.value))
const handleSaveAs = () => run(() => saveAs(target.value))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show && (filename || filePath)"
      ref="menuRef"
      class="attachment-context-menu"
      :style="{ left: adjustedPosition.x + 'px', top: adjustedPosition.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="menu-item" :disabled="!hasPath" @click="handleOpen">
        <File :size="14" />
        <span>{{ t('ai.attachmentMenu.open') }}</span>
      </button>
      <button class="menu-item" :disabled="!hasPath" @click="handleShowInFolder">
        <FolderOpen :size="14" />
        <span>{{ t('ai.attachmentMenu.showInFolder') }}</span>
      </button>
      <div class="menu-divider" />
      <button class="menu-item" :disabled="!hasPath" @click="handleCopyPath">
        <Copy :size="14" />
        <span>{{ t('ai.attachmentMenu.copyPath') }}</span>
      </button>
      <button class="menu-item" :disabled="!filename && !hasPath" @click="handleCopyFilename">
        <Copy :size="14" />
        <span>{{ t('ai.attachmentMenu.copyFilename') }}</span>
      </button>
      <div class="menu-divider" />
      <button class="menu-item" :disabled="!hasPath" @click="handleSaveAs">
        <Download :size="14" />
        <span>{{ t('ai.attachmentMenu.saveAs') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.attachment-context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 6px;
  z-index: 100000;
  animation: fadeIn 0.1s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.95); }
  to   { opacity: 1; transform: scale(1); }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:hover:not(:disabled) { background: var(--bg-hover); }
.menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.menu-item svg { color: var(--text-muted); flex-shrink: 0; }
.menu-item:hover:not(:disabled) svg { color: var(--text-secondary); }
.menu-item span:first-of-type { flex: 1; }

.menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 6px;
}
</style>
