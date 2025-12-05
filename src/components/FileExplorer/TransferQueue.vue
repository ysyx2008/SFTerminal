<script setup lang="ts">
import { computed } from 'vue'
import type { TransferProgress } from '../../composables/useSftp'

const props = defineProps<{
  transfers: TransferProgress[]
}>()

// 是否有传输任务
const hasTransfers = computed(() => props.transfers.length > 0)

// 活跃传输数量
const activeCount = computed(() => 
  props.transfers.filter(t => t.status === 'transferring' || t.status === 'pending').length
)

// 格式化大小
const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

// 格式化速度
const formatSpeed = (progress: TransferProgress): string => {
  if (progress.status !== 'transferring') return ''
  const elapsed = (Date.now() - progress.startTime) / 1000
  if (elapsed < 0.1) return ''
  const speed = progress.transferredBytes / elapsed
  return `${formatSize(speed)}/s`
}

// 获取状态文本
const getStatusText = (status: TransferProgress['status']): string => {
  switch (status) {
    case 'pending': return '等待中'
    case 'transferring': return '传输中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    default: return ''
  }
}

// 获取状态颜色类
const getStatusClass = (status: TransferProgress['status']): string => {
  switch (status) {
    case 'completed': return 'success'
    case 'failed': return 'error'
    case 'cancelled': return 'muted'
    default: return ''
  }
}
</script>

<template>
  <div v-if="hasTransfers" class="transfer-queue">
    <div class="queue-header">
      <span class="queue-title">
        传输队列
        <span v-if="activeCount > 0" class="active-badge">{{ activeCount }}</span>
      </span>
    </div>

    <div class="queue-list">
      <div
        v-for="transfer in transfers"
        :key="transfer.transferId"
        class="transfer-item"
        :class="getStatusClass(transfer.status)"
      >
        <!-- 方向图标 -->
        <span class="direction-icon">
          <!-- 上传 -->
          <svg v-if="transfer.direction === 'upload'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="17 11 12 6 7 11"/>
            <line x1="12" y1="6" x2="12" y2="18"/>
          </svg>
          <!-- 下载 -->
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="7 13 12 18 17 13"/>
            <line x1="12" y1="18" x2="12" y2="6"/>
          </svg>
        </span>

        <!-- 文件信息 -->
        <div class="transfer-info">
          <div class="transfer-name" :title="transfer.filename">{{ transfer.filename }}</div>
          <div class="transfer-progress-bar" v-if="transfer.status === 'transferring' || transfer.status === 'pending'">
            <div class="progress-fill" :style="{ width: transfer.percent + '%' }"></div>
          </div>
        </div>

        <!-- 进度信息 -->
        <div class="transfer-stats">
          <template v-if="transfer.status === 'transferring'">
            <span class="percent">{{ transfer.percent }}%</span>
            <span class="speed">{{ formatSpeed(transfer) }}</span>
          </template>
          <template v-else-if="transfer.status === 'pending'">
            <span class="status-text">{{ getStatusText(transfer.status) }}</span>
          </template>
          <template v-else>
            <span class="status-text" :class="getStatusClass(transfer.status)">
              {{ getStatusText(transfer.status) }}
            </span>
          </template>
        </div>

        <!-- 状态图标 -->
        <span class="status-icon" :class="getStatusClass(transfer.status)">
          <!-- 完成 -->
          <svg v-if="transfer.status === 'completed'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <!-- 失败 -->
          <svg v-else-if="transfer.status === 'failed'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <!-- 取消 -->
          <svg v-else-if="transfer.status === 'cancelled'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.transfer-queue {
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
  max-height: 150px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.queue-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.active-badge {
  background: var(--accent-primary);
  color: var(--bg-primary);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
}

.queue-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.transfer-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  transition: background 0.15s;
}

.transfer-item:hover {
  background: var(--bg-surface);
}

.direction-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--accent-primary);
  flex-shrink: 0;
}

.transfer-item.success .direction-icon {
  color: var(--accent-success);
}

.transfer-item.error .direction-icon {
  color: var(--accent-error);
}

.transfer-item.muted .direction-icon {
  color: var(--text-muted);
}

.transfer-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.transfer-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.transfer-progress-bar {
  height: 3px;
  background: var(--bg-hover);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.transfer-stats {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 60px;
}

.percent {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.speed {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.status-text {
  font-size: 11px;
  color: var(--text-muted);
}

.status-text.success {
  color: var(--accent-success);
}

.status-text.error {
  color: var(--accent-error);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.status-icon.success {
  color: var(--accent-success);
}

.status-icon.error {
  color: var(--accent-error);
}

.status-icon.muted {
  color: var(--text-muted);
}
</style>
