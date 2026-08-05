/**
 * 人机双写冲突决策（纯函数，无 Vue/Pinia 依赖）
 *
 * 磁盘文件是用户与 Agent 共同的真相源。本模块决定「外部内容到达面板时如何分流」：
 * 用户草稿未偏离磁盘基线 → 直接接受；已偏离 → 挂起外部版本，保护用户草稿。
 *
 * @see packages/workbench-assistant/src/artifact/SPEC.md「设计目标：人机双写」
 */

export interface CoeditEntry {
  /** 最近一次确认的磁盘内容（读盘回填 / Agent 推送 / 保存成功三处更新） */
  baseline?: string
  /** 冲突时被挂起的外部版本（等用户选择载入或保留自己的修改） */
  deferred?: string
  /** 渲染器推送：当前草稿 ≠ 磁盘基线 */
  dirty: boolean
}

export function createCoeditEntry(): CoeditEntry {
  return { dirty: false }
}

export type ExternalContentDecision = 'applied' | 'deferred'

/**
 * 外部（Agent 改盘 / 磁盘回填）内容进入时的分流：
 * - 渲染器已标记 dirty → 挂起（即使基线尚未建立——用户已在打字，保护优先）
 * - 尚无基线（该产出物第一次收到外部内容）→ 接受并建立基线
 * - store 现存内容已偏离基线（用户草稿已 flush 进 store）→ 挂起
 * - 其余 → 接受
 */
export function decideExternalContent(
  entry: CoeditEntry | undefined,
  currentContent: string,
): ExternalContentDecision {
  if (entry?.dirty) return 'deferred'
  if (!entry || entry.baseline === undefined) return 'applied'
  if (currentContent !== entry.baseline) return 'deferred'
  return 'applied'
}

/** 接受外部内容后：基线前进到该版本，冲突与 dirty 解除 */
export function entryAfterApply(_entry: CoeditEntry | undefined, content: string): CoeditEntry {
  return { baseline: content, dirty: false, deferred: undefined }
}

/** 挂起外部内容后：基线前进到磁盘真相，挂起版本待用户裁决；草稿必然已偏离新基线 → dirty 恒为 true */
export function entryAfterDefer(_entry: CoeditEntry | undefined, content: string): CoeditEntry {
  return { baseline: content, deferred: content, dirty: true }
}

/** 用户保存成功：基线 = 草稿，冲突与 dirty 解除 */
export function entryAfterSave(_entry: CoeditEntry | undefined, content: string): CoeditEntry {
  return { baseline: content, dirty: false, deferred: undefined }
}

/**
 * WYSIWYG 编辑器规范化回写：基线前进到规范化内容，冲突与 dirty 解除。
 * 与 entryAfterSave 迁移形状相同但语义独立——此处不携带任何「磁盘保存」副作用，
 * 未来为保存增加副作用（如保存时间戳）时不得并入本函数。
 */
export function entryAfterCanonicalize(_entry: CoeditEntry | undefined, content: string): CoeditEntry {
  return { baseline: content, dirty: false, deferred: undefined }
}

/** 用户选择「保留我的修改」：仅关闭提示，dirty 保持（草稿仍偏离基线） */
export function entryAfterDismissDeferred(entry: CoeditEntry | undefined): CoeditEntry {
  return { baseline: entry?.baseline, dirty: entry?.dirty ?? false, deferred: undefined }
}
