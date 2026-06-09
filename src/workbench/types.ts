/**
 * Workbench（工作台）模型类型定义
 *
 * 一个 Tab 就是一个工作台实例。工作台 = 一组具名区域（Region）的固定组合：
 * 一个常驻锚点区 + 若干可显隐的辅助区，区域之间可拖分隔条调比例。
 *
 * 设计原则（详见会话纪要）：
 * - 组合 + 贡献，不是开关 + 枚举：工作台由区域拼成，不用一堆 hasXxx 能力位描述。
 * - 工具以叠加为主、允许覆盖：核心工具是基线，工作台按需贡献/覆盖专用工具（后端 mode 不受影响）。
 * - 布局是固定模板：区域只显隐 / 拖比例，不带焦点高亮、不带递归分割（那是终端 panel 私有的 SplitPane）。
 *
 * 渲染分两种方式：
 * - 声明式区域（regions）：交给通用 WorkbenchShell 渲染（助手、未来的浏览器等）。
 * - 自定义渲染器（renderer，逃生口）：工作台有特殊 chrome 时直接用专属组件渲染
 *   （终端工作台因 Terminal 实例 Teleport 保命池而特殊，走此路）。
 */
import type { Component } from 'vue'
import type { TerminalType } from '@shared/types'

/**
 * 工作台类型。
 *
 * 复用现有 `TerminalType`（'local' | 'ssh' | 'assistant'）作为唯一数据源，
 * 避免与 tab.type 产生第二套枚举。未来新增工作台（如 'browser'）时在 TerminalType 上扩展。
 */
export type WorkbenchKind = TerminalType

/** 区域角色：anchor=常驻锚点区；toggle=可显隐辅助区 */
export type RegionRole = 'anchor' | 'toggle'

/** 区域所在侧（仅 toggle 区域有意义） */
export type RegionSide = 'left' | 'right'

/**
 * 区域声明。
 *
 * 注：当前内置工作台均通过 `renderer` 自定义组件渲染，`regions` 暂作意图声明 /
 * 未来声明式工作台使用。新增「无特殊 chrome」的工作台时，可只填 regions 交给 WorkbenchShell。
 */
export interface RegionSpec {
  /** 区域标识（工作台内唯一） */
  id: string
  /** 角色：锚点常驻 / 辅助可隐 */
  role: RegionRole
  /** toggle 区域所在侧，默认 'right' */
  side?: RegionSide
  /** 辅助区默认是否可见，默认 false */
  defaultVisible?: boolean
  /** 是否允许拖分隔条调尺寸，默认 true */
  resizable?: boolean
}

/**
 * 工作台描述。一种工作台一条，集中登记在 registry，供查表分发。
 */
export interface WorkbenchDescriptor {
  /** 工作台类型 */
  kind: WorkbenchKind
  /**
   * 自定义渲染器（逃生口）。提供则直接用它渲染整个工作台，忽略 regions。
   * 渲染器组件统一接收 props：`{ tab: TerminalTab; isActive: boolean }`。
   */
  renderer?: Component
  /**
   * 声明式区域。无 renderer 时由通用 WorkbenchShell 按此渲染。
   * 当前内置工作台都走 renderer，此字段为未来声明式工作台预留。
   */
  regions?: RegionSpec[]
  /** 是否在 Steam 构建中可用（助手类工作台在 Steam 版不提供） */
  availableInSteam?: boolean
}
