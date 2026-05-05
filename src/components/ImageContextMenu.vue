<script setup lang="ts">
/**
 * 图片右键菜单
 *
 * 用于聊天消息列表的小缩略图、以及大图预览模态框。
 * 触发方式：父组件捕获 @contextmenu，调 open(x, y, url)；菜单自行处理点击与外部关闭。
 *
 * 行为：
 * - 复制图片：跨应用粘贴友好（统一 PNG）
 * - 另存为：保留原始格式（SVG 矢量保留，PNG/JPEG 同名）
 *
 * 样式与定位逻辑参照 FileContextMenu.vue，保持视觉一致。
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Download } from 'lucide-vue-next'
import { useImageActions } from '../composables/useImageActions'

const { t } = useI18n()
const { copyImage, saveImageAs } = useImageActions()

const props = defineProps<{
  show: boolean
  x: number
  y: number
  url: string | null
  /** 用于生成默认文件名前缀，如 'chart' */
  defaultName?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)
const adjustedPosition = ref({ x: 0, y: 0 })

const isMac = computed(() => typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC'))
const copyShortcut = computed(() => isMac.value ? '⌘C' : 'Ctrl+C')

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
  // 必须先判断 show——ImageContextMenu 在父组件里始终 mount，
  // 不加守卫会无条件吞掉 ESC，让大图预览/其他弹窗的 ESC 关闭逻辑失效。
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

const handleCopy = async () => {
  if (!props.url) return
  emit('close')
  try { await copyImage(props.url) } catch { /* toast 已显示 */ }
}

const handleSaveAs = async () => {
  if (!props.url) return
  emit('close')
  try { await saveImageAs(props.url, { defaultName: props.defaultName }) } catch { /* toast 已显示 */ }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show && url"
      ref="menuRef"
      class="image-context-menu"
      :style="{ left: adjustedPosition.x + 'px', top: adjustedPosition.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="menu-item" @click="handleCopy">
        <Copy :size="14" />
        <span>{{ t('ai.imageMenu.copy') }}</span>
        <span class="shortcut">{{ copyShortcut }}</span>
      </button>
      <button class="menu-item" @click="handleSaveAs">
        <Download :size="14" />
        <span>{{ t('ai.imageMenu.saveAs') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.image-context-menu {
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

.menu-item:hover { background: var(--bg-hover); }
.menu-item svg { color: var(--text-muted); flex-shrink: 0; }
.menu-item:hover svg { color: var(--text-secondary); }
.menu-item span:first-of-type { flex: 1; }
.menu-item .shortcut {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}
</style>
