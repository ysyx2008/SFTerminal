/**
 * Workbench（工作台）模型类型定义
 *
 * 真相源：`@sailfish/workbench-sdk`（原 `src/workbench/types.ts`）。
 */
import type { Component } from 'vue'
import type { McpServerConfig, TerminalType } from '@sailfish/shared-types'

/**
 * 工作台类型 —— `TerminalType` 的超集。
 *
 * `(string & {})` 保留内置 kind 补全，同时允许业务/OEM 自定义 kind。
 */
export type WorkbenchKind = TerminalType | 'companion' | (string & {})

export type RegionRole = 'anchor' | 'toggle'
export type RegionSide = 'left' | 'right'

export interface RegionSpec {
  id: string
  role: RegionRole
  side?: RegionSide
  defaultVisible?: boolean
  resizable?: boolean
}

export interface WorkbenchDescriptor {
  kind: WorkbenchKind
  renderer?: Component
  regions?: RegionSpec[]
  availableInSteam?: boolean
  skills?: string[]
  mcpServers?: McpServerConfig[]
  agentPrompt?: string | ((tab: WorkbenchAgentPromptTab) => string | undefined)
  agentPolicy?: {
    memory?: boolean
    recall?: boolean
    executionMode?: string
  }
}

export interface WorkbenchAgentPromptTab {
  type: string
  isRemote?: boolean
  remoteChannel?: string
}

/**
 * 工作台渲染器 props 的最小约定（与 App `<component :is>` 一致）。
 * 桌面 `TerminalTab` 可赋给此形状；岗包优先用本类型，避免依赖 `@/stores/terminal`。
 */
export interface WorkbenchRendererProps {
  tab: { id: string; title?: string }
  isActive: boolean
}
