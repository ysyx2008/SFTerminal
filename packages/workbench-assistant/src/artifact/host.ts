/**
 * 助手产出物 ↔ desktop 宿主契约。
 *
 * 岗包不直引 terminalStore；由 desktop 在启动时 registerArtifactDesktopHost。
 */
import type { AgentStep } from '@sailfish/shared-types'

export interface ArtifactDesktopHost {
  /** 当前 tab 的 Agent steps（溯源解析 / step→canvas 接线） */
  getAgentSteps(tabId: string): readonly AgentStep[]
  /** 是否为当前激活 tab（快捷键作用域等） */
  isTabActive(tabId: string): boolean
  /** 将产出物清单持久化到历史会话 */
  persistArtifacts(tabId: string): void
}

let host: ArtifactDesktopHost | null = null

export function registerArtifactDesktopHost(next: ArtifactDesktopHost): void {
  host = next
}

export function getArtifactDesktopHost(): ArtifactDesktopHost | null {
  return host
}

export function requireArtifactDesktopHost(): ArtifactDesktopHost {
  if (!host) {
    throw new Error('[workbench-assistant] ArtifactDesktopHost 未注册：请在 desktop 启动时调用 registerArtifactDesktopHost')
  }
  return host
}
