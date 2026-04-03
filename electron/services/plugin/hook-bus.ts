/**
 * Hook 事件总线
 * 
 * 支持插件注册生命周期 hook，在 Agent 执行流程的关键节点触发。
 * 实现 OpenClaw 的 hook 语义：block/cancel = true 具有 terminal 效果（短路后续 handler）。
 */

import type {
  HookEvent,
  HookHandler,
  HookDecision,
  HookContext
} from './types'
import { createLogger } from '../../utils/logger'

const log = createLogger('HookBus')

export class HookBus {
  private handlers = new Map<HookEvent, Array<{ pluginId: string; handler: HookHandler }>>()

  register(pluginId: string, event: HookEvent, handler: HookHandler): void {
    let list = this.handlers.get(event)
    if (!list) {
      list = []
      this.handlers.set(event, list)
    }
    list.push({ pluginId, handler })
    log.info(`Hook registered: ${event} by plugin "${pluginId}"`)
  }

  /**
   * 触发 hook 并聚合决策
   * - block: true / cancel: true 具有 terminal 语义，短路后续 handler
   * - requireApproval: true 累积但不短路
   */
  async trigger(event: HookEvent, context: HookContext): Promise<HookDecision> {
    const list = this.handlers.get(event)
    if (!list || list.length === 0) return {}

    const aggregated: HookDecision = {}

    for (const { pluginId, handler } of list) {
      try {
        const decision = await handler(context)
        if (!decision) continue

        if (decision.block) {
          log.info(`Hook ${event}: blocked by plugin "${pluginId}"`)
          return { ...aggregated, block: true }
        }
        if (decision.cancel) {
          log.info(`Hook ${event}: cancelled by plugin "${pluginId}"`)
          return { ...aggregated, cancel: true }
        }
        if (decision.requireApproval) {
          aggregated.requireApproval = true
        }
        if (decision.modified !== undefined) {
          aggregated.modified = decision.modified
        }
      } catch (err) {
        log.error(`Hook ${event} handler from plugin "${pluginId}" threw:`, err)
      }
    }

    return aggregated
  }

  /** 移除某插件注册的所有 hook */
  removePlugin(pluginId: string): void {
    for (const [event, list] of this.handlers) {
      const filtered = list.filter(h => h.pluginId !== pluginId)
      if (filtered.length === 0) {
        this.handlers.delete(event)
      } else {
        this.handlers.set(event, filtered)
      }
    }
  }

  /** 检查某事件是否有 handler */
  hasHandlers(event: HookEvent): boolean {
    const list = this.handlers.get(event)
    return !!list && list.length > 0
  }

  clear(): void {
    this.handlers.clear()
  }
}
