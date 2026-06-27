/**
 * 历史日期工具纯函数。
 *
 * 从 HistoryService 抽出供 `AgentRecordStore` 与 `HistoryService`（聊天记录 / Token 统计 /
 * 清理）共用，避免在两个类里各写一份 `toISOString().split('T')[0]`。
 */
export function getDateString(timestamp?: number): string {
  const date = timestamp ? new Date(timestamp) : new Date()
  return date.toISOString().split('T')[0] // YYYY-MM-DD
}
