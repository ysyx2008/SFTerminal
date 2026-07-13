/**
 * 工作台注册表存储（无 Vue 业务依赖，可供单测 / prompt 解析使用）
 */
import type { WorkbenchDescriptor, WorkbenchKind } from './types'

const descriptors = new Map<string, WorkbenchDescriptor>()

export function registerWorkbench(descriptor: WorkbenchDescriptor): void {
  if (!descriptor?.kind) {
    throw new Error('registerWorkbench: descriptor.kind is required')
  }
  descriptors.set(descriptor.kind, descriptor)
}

export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined {
  return descriptors.get(kind)
}

export function listWorkbenchDescriptors(): WorkbenchDescriptor[] {
  return Array.from(descriptors.values())
}

export function clearWorkbenchRegistryForTests(): void {
  descriptors.clear()
}
