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
