/**
 * Workbench 注册表
 *
 * 聚合各 kind 的 descriptor，供 App.vue 查表分发（`<component :is>`）。
 * 内置工作台在模块加载时 register；业务/OEM 也可调用 registerWorkbench。
 */
import type { Component } from 'vue'
import type { TerminalType } from '@shared/types'
import { COMPANION_AGENT_KEY } from '@shared/types'
import { isOemFeatureEnabled, type OemFeatureKey } from '@shared/oem-features'
import TerminalTabView from '../components/TerminalTabView.vue'
import type { WorkbenchKind } from './types'
import { getWorkbenchDescriptor, registerWorkbench } from './registry-store'
import { descriptor as localDescriptor } from './local/descriptor'
import { descriptor as sshDescriptor } from './ssh/descriptor'
import { descriptor as assistantDescriptor } from '@sailfish/workbench-assistant/descriptor'
import { descriptor as companionDescriptor } from './companion/descriptor'

export {
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  registerWorkbench,
} from './registry-store'

const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

/**
 * 联络 tab 的身份标识。单一来源为 `@shared/types` 的 `COMPANION_AGENT_KEY`
 * （亦即 `stores/terminal.ts` 的 `COMPANION_TAB_AGENT_ID` 与后端 `__companion__`）。
 */
const COMPANION_AGENT_ID = COMPANION_AGENT_KEY

/** kind → OEM feature；觉醒/关切等产品块不经此表（见 isOemFeatureEnabled） */
const KIND_FEATURE: Partial<Record<string, OemFeatureKey>> = {
  local: 'localTerminal',
  ssh: 'sshTerminal',
  assistant: 'assistantWorkbench',
  companion: 'companion',
}

/**
 * 把 tab 映射成工作台类型 —— 「tab → WorkbenchKind」的唯一映射点。
 *
 * 多数情况 kind === tab.type；联络是例外：tab.type='assistant' 但用独立的 companion 工作台。
 */
export function resolveWorkbenchKind(tab: {
  type: TerminalType
  agentId?: string
  workbenchKind?: string
}): WorkbenchKind {
  if (tab.workbenchKind) {
    return tab.workbenchKind as WorkbenchKind
  }
  if (tab.type === 'assistant' && tab.agentId === COMPANION_AGENT_ID) {
    return 'companion'
  }
  return tab.type
}

/**
 * 工作台是否对当前构建 / OEM 可用 —— 唯一裁剪判定点。
 * 合并 oem.config.features 与 Steam（availableInSteam）。
 */
export function isWorkbenchAvailable(kind: WorkbenchKind): boolean {
  const desc = getWorkbenchDescriptor(kind)
  if (!desc) return false
  if (isSteamBuild && desc.availableInSteam === false) return false
  const featureKey = KIND_FEATURE[kind]
  if (featureKey && !isOemFeatureEnabled(featureKey)) return false
  return true
}

/**
 * 解析某个工作台类型应使用的渲染器组件。
 *
 * 不可用时回退到终端渲染器（避免白屏）；创建入口应先问 isWorkbenchAvailable。
 */
export function resolveWorkbenchRenderer(kind: WorkbenchKind): Component {
  if (!isWorkbenchAvailable(kind)) {
    return TerminalTabView
  }
  const desc = getWorkbenchDescriptor(kind)
  if (desc?.renderer) {
    return desc.renderer
  }
  return TerminalTabView
}

// 内置工作台
registerWorkbench(localDescriptor)
registerWorkbench(sshDescriptor)
registerWorkbench(assistantDescriptor)
registerWorkbench(companionDescriptor)
