/**
 * MCP 工具在 UI 中的展示名解析（步骤卡片、流式预卡片、确认框等）
 */
import { t } from './agent/i18n'

export interface McpToolDisplaySource {
  name: string
  description?: string
  title?: string
}

/** 从 MCP 工具元数据解析人类可读展示名（优先中文 title/description） */
export function resolveMcpToolDisplayLabel(tool: McpToolDisplaySource): string {
  const title = tool.title?.trim()
  if (title) return title

  const desc = tool.description?.trim()
  if (desc) {
    const firstLine = desc.split(/\r?\n/)[0]?.trim() ?? ''
    if (firstLine.length > 0 && firstLine.length <= 80) {
      return firstLine.replace(/[。.!！?？]+$/, '').trim()
    }
  }

  return humanizeSnakeCaseName(tool.name)
}

/** tool_call 步骤 content，与流式预卡片 customRender 共用，避免接管时跳变 */
export function formatMcpToolCallContent(displayLabel: string): string {
  return `${t('mcp.calling_tool')}: ${displayLabel}`
}

function humanizeSnakeCaseName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
