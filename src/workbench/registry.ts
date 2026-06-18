/**
 * Workbench 注册表
 *
 * 聚合各 kind 子目录的 descriptor，供 App.vue 查表分发（`<component :is>`）。
 */
import type { Component } from 'vue'
import TerminalTabView from '../components/TerminalTabView.vue'
import type { WorkbenchDescriptor, WorkbenchKind } from './types'
import { descriptor as localDescriptor } from './local/descriptor'
import { descriptor as sshDescriptor } from './ssh/descriptor'
import { descriptor as assistantDescriptor } from './assistant/descriptor'

const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

const DESCRIPTORS: Record<WorkbenchKind, WorkbenchDescriptor> = {
  local: localDescriptor,
  ssh: sshDescriptor,
  assistant: assistantDescriptor,
}

export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined {
  return DESCRIPTORS[kind]
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
