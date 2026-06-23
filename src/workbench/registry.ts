/**
 * Workbench 注册表
 *
 * 聚合各 kind 子目录的 descriptor，供 App.vue 查表分发（`<component :is>`）。
 */
import type { Component } from 'vue'
import type { TerminalType } from '@shared/types'
import TerminalTabView from '../components/TerminalTabView.vue'
import type { WorkbenchDescriptor, WorkbenchKind } from './types'
import { descriptor as localDescriptor } from './local/descriptor'
import { descriptor as sshDescriptor } from './ssh/descriptor'
import { descriptor as assistantDescriptor } from './assistant/descriptor'
import { descriptor as companionDescriptor } from './companion/descriptor'

const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

/**
 * 联络 tab 的身份标识。与 `stores/terminal.ts` 的 `COMPANION_TAB_AGENT_ID`、
 * 后端 `__companion__` 一致；此处用字面量避免 workbench 层反向依赖 stores 层（分层方向：stores → workbench）。
 */
const COMPANION_AGENT_ID = '__companion__'

const DESCRIPTORS: Record<WorkbenchKind, WorkbenchDescriptor> = {
  local: localDescriptor,
  ssh: sshDescriptor,
  assistant: assistantDescriptor,
  companion: companionDescriptor,
}

export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined {
  return DESCRIPTORS[kind]
}

/**
 * 把 tab 映射成工作台类型 —— 「tab → WorkbenchKind」的唯一映射点。
 *
 * 多数情况 kind === tab.type；联络是例外：tab.type='assistant' 但用独立的 companion 工作台。
 * 所有按身份分流的逻辑都收敛于此，不散落到组件/调用点。
 */
export function resolveWorkbenchKind(tab: { type: TerminalType; agentId?: string }): WorkbenchKind {
  if (tab.type === 'assistant' && tab.agentId === COMPANION_AGENT_ID) {
    return 'companion'
  }
  return tab.type
}

/**
 * 解析某个工作台类型应使用的渲染器组件。
 *
 * Steam 构建下助手工作台不可用，回退到终端渲染器。
 */
export function resolveWorkbenchRenderer(kind: WorkbenchKind): Component {
  const desc = DESCRIPTORS[kind]
  if (desc?.renderer && (desc.availableInSteam || !isSteamBuild)) {
    return desc.renderer
  }
  return TerminalTabView
}
