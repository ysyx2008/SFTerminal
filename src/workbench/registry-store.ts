/**
 * 工作台注册表存储（无 Vue 依赖，可供单测 / prompt 解析使用）
 */
import type { WorkbenchDescriptor, WorkbenchKind } from './types'

const descriptors = new Map<string, WorkbenchDescriptor>()

/**
 * 注册工作台。同 kind 后注册覆盖先注册（便于 OEM 替换内置）。
 */
export function registerWorkbench(descriptor: WorkbenchDescriptor): void {
  if (!descriptor?.kind) {
    throw new Error('registerWorkbench: descriptor.kind is required')
  }
  descriptors.set(descriptor.kind, descriptor)
}

export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined {
  return descriptors.get(kind)
}

/** 遍历已注册工作台（启动装配 skills/mcp 用） */
export function listWorkbenchDescriptors(): WorkbenchDescriptor[] {
  return Array.from(descriptors.values())
}

/** 测试用：清空注册表 */
export function clearWorkbenchRegistryForTests(): void {
  descriptors.clear()
}
