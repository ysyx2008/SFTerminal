<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, AlertCircle, HelpCircle } from 'lucide-vue-next'
import type { ConfirmDialogOptions } from '../../composables/useConfirm'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  show: boolean
  options: ConfirmDialogOptions
}>(), {
  show: false
})

const emit = defineEmits<{
  confirm: []
  cancel: []
  neutral: []
  close: []
}>()

const dialogRef = ref<HTMLDivElement | null>(null)
const confirmBtnRef = ref<HTMLButtonElement | null>(null)

// 处理确认
const handleConfirm = () => {
  emit('confirm')
  emit('close')
}

// 处理取消
const handleCancel = () => {
  emit('cancel')
  emit('close')
}

// 处理中性按钮（既非确认也非取消的第三种动作）
const handleNeutral = () => {
  emit('neutral')
  emit('close')
}

// 键盘事件
const handleKeydown = (e: KeyboardEvent) => {
  if (!props.show) return
  
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation() // 阻止事件传播到父组件，防止同时关闭其他弹窗
    handleCancel()
  } else if (e.key === 'Enter') {
    // 当焦点已经移到具体按钮上时（用户用 Tab 切到 cancel/neutral），让浏览器默认行为
    // 触发该按钮的 click——这样三按钮场景下用户能用键盘选 neutral。
    // 仅当焦点不在任何按钮上时才走默认 confirm。
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement && dialogRef.value?.contains(focused)) {
      return
    }
    e.preventDefault()
    handleConfirm()
  }
}

// 聚焦到确认按钮
watch(() => props.show, async (show) => {
  if (show) {
    await nextTick()
    confirmBtnRef.value?.focus()
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// 获取类型图标
const getIcon = () => {
  switch (props.options.type) {
    case 'danger':
      return 'danger'
    case 'warning':
      return 'warning'
    default:
      return 'info'
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show" class="confirm-overlay" @click.self="handleCancel">
        <Transition name="scale">
          <div v-if="show" ref="dialogRef" class="confirm-dialog" :class="[options.type || 'default', { 'has-neutral': !!options.neutralText }]">
            <!-- 图标 -->
            <div class="dialog-icon" :class="getIcon()">
              <AlertTriangle v-if="options.type === 'danger'" :size="24" />
              <AlertCircle v-else-if="options.type === 'warning'" :size="24" />
              <HelpCircle v-else :size="24" />
            </div>

            <!-- 标题 -->
            <h3 class="dialog-title">{{ options.title }}</h3>

            <!-- 消息 -->
            <p class="dialog-message">{{ options.message }}</p>

            <!-- 文件信息 -->
            <div v-if="options.fileInfo" class="file-info">
              <div v-if="options.fileInfo.name" class="file-info-item">
                <span class="label">{{ t('common.name') }}</span>
                <span class="value" :title="options.fileInfo.name">{{ options.fileInfo.name }}</span>
              </div>
              <div v-if="options.fileInfo.type" class="file-info-item">
                <span class="label">{{ t('common.type') }}</span>
                <span class="value">{{ options.fileInfo.type }}</span>
              </div>
              <div v-if="options.fileInfo.size" class="file-info-item">
                <span class="label">{{ t('common.size') }}</span>
                <span class="value">{{ options.fileInfo.size }}</span>
              </div>
              <div v-if="options.fileInfo.count" class="file-info-item">
                <span class="label">{{ t('common.count') }}</span>
                <span class="value">{{ options.fileInfo.count }} {{ t('common.items') }}</span>
              </div>
            </div>

            <!-- 详细信息 -->
            <p v-if="options.detail" class="dialog-detail">{{ options.detail }}</p>

            <!-- 按钮 -->
            <div class="dialog-buttons">
              <button 
                v-if="options.showCancel !== false"
                class="btn btn-cancel" 
                @click="handleCancel"
              >
                {{ options.cancelText || t('common.cancel') }}
              </button>
              <button
                v-if="options.neutralText"
                class="btn btn-neutral"
                @click="handleNeutral"
              >
                {{ options.neutralText }}
              </button>
              <button 
                ref="confirmBtnRef"
                class="btn btn-confirm" 
                :class="options.type || 'default'"
                @click="handleConfirm"
              >
                {{ options.confirmText || t('common.confirm') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(2px);
}

.confirm-dialog {
  width: 380px;
  max-width: 90vw;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

/* 三按钮场景需要更多横向空间，否则按钮文字会被强制换成多行（视觉很挤）。 */
.confirm-dialog.has-neutral {
  width: 480px;
}

/* 图标 */
.dialog-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.dialog-icon.info {
  background: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-primary);
}

.dialog-icon.warning {
  background: rgba(var(--color-warning-rgb), 0.15);
  color: var(--color-warning);
}

/* 强警示：危险操作（删除/高危命令）—— 走 --brand-alert */
.dialog-icon.danger {
  background: rgba(var(--brand-alert-rgb), 0.15);
  color: var(--brand-alert);
}

/* 标题 */
.dialog-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

/* 消息 */
.dialog-message {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

/* 文件信息 */
.file-info {
  width: 100%;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}

.file-info-item {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
}

.file-info-item .label {
  color: var(--text-muted);
}

.file-info-item .value {
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 详细信息 */
.dialog-detail {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 16px 0;
}

/* 按钮 */
.dialog-buttons {
  display: flex;
  gap: 12px;
  width: 100%;
}

.btn {
  flex: 1;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  /* 强制按钮文字单行显示，避免在窄容器里被拆成多行造成视觉拥挤；
     文案过长则触发省略号（设计上应避免，必要时由调用方加宽 dialog）。 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-cancel {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 中性按钮：用于"打开设置"等独立动作，视觉上比 cancel 显眼但不抢主按钮的焦点 */
.btn-neutral {
  background: transparent;
  color: var(--accent-primary);
  border: 1px solid var(--accent-primary);
}

.btn-neutral:hover {
  background: rgba(var(--accent-rgb), 0.1);
}

.btn-confirm {
  background: var(--accent-primary);
  color: white;
}

.btn-confirm:hover {
  filter: brightness(1.1);
}

/* 强警示确认按钮 —— 走 --brand-alert */
.btn-confirm.danger {
  background: var(--brand-alert);
}

.btn-confirm.danger:hover {
  background: var(--brand-alert-end);
  filter: none;
}

.btn-confirm.warning {
  background: var(--color-warning);
  color: var(--bg-primary);
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
