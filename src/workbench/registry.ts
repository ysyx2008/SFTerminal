/**
 * Workbench 注册表
 *
 * 集中登记内置工作台，供 App.vue 查表分发（`<component :is>`）。
 * 新增工作台只需在此加一条 descriptor + 提供渲染器/区域，无需改动 App.vue 的分发逻辑。
 *
 * 当前内置工作台都通过自定义渲染器（renderer）渲染：
 * - 终端（local/ssh）：走逃生口 TerminalTabView（含 Terminal Teleport 保命池，结构特殊）。
 * - 助手（assistant）：AssistantWorkbench（声明式区域，内部组合通用 WorkbenchShell）。
 */
import type { Component } from 'vue'
import TerminalTabView from '../components/TerminalTabView.vue'
import AssistantWorkbench from '../components/workbench/AssistantWorkbench.vue'
import type { WorkbenchDescriptor, WorkbenchKind } from './types'

const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

const DESCRIPTORS: Record<WorkbenchKind, WorkbenchDescriptor> = {
  local: { kind: 'local', renderer: TerminalTabView, availableInSteam: true },
  ssh: { kind: 'ssh', renderer: TerminalTabView, availableInSteam: true },
  assistant: { kind: 'assistant', renderer: AssistantWorkbench, availableInSteam: false },
}

export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined {
  return DESCRIPTORS[kind]
}

/**
 * 解析某个工作台类型应使用的渲染器组件。
 *
 * 终端类工作台与（非 Steam 构建下的）助手工作台使用各自的 renderer；
 * Steam 构建下助手工作台不可用，回退到终端渲染器——与原 App.vue
 * `v-if="assistant && !isSteamBuild" … v-else TerminalTabView` 的行为保持一致。
 */
export function resolveWorkbenchRenderer(kind: WorkbenchKind): Component {
  const desc = DESCRIPTORS[kind]
  if (desc?.renderer && (desc.availableInSteam || !isSteamBuild)) {
    return desc.renderer
  }
  return TerminalTabView
}
