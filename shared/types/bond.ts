/**
 * 羁绊系统共享类型
 * 量化用户与 Agent 的关系深度，影响对话语气和行为
 */

/** 羁绊等级（信任阶段） */
export type BondTrustLevel = 'stranger' | 'acquaintance' | 'companion' | 'soulmate'

/** 信任阶段从低到高（用于 placeholder 等按羁绊解锁） */
export const BOND_TRUST_ORDER: BondTrustLevel[] = [
  'stranger',
  'acquaintance',
  'companion',
  'soulmate',
]

export function bondTrustAtLeast(
  current: BondTrustLevel,
  minimum: BondTrustLevel
): boolean {
  return BOND_TRUST_ORDER.indexOf(current) >= BOND_TRUST_ORDER.indexOf(minimum)
}

/** 输入框 placeholder 分池最低羁绊要求 */
export const COMPOSER_PLACEHOLDER_POOL_GATES: Record<string, BondTrustLevel> = {
  ocean: 'stranger',
  rivals: 'acquaintance',
  bondCompanion: 'companion',
  bondSoulmate: 'soulmate',
  lore: 'companion',
}

/** 羁绊里程碑定义（与 BondService 持久化 id 一致） */
export interface BondMilestoneDefinition {
  id: string
  threshold: number
  label_zh: string
  label_en: string
}

export const BOND_MILESTONES: BondMilestoneDefinition[] = [
  { id: 'bond_first_meet', threshold: 1, label_zh: '初次相见', label_en: 'First Meeting' },
  { id: 'bond_getting_along', threshold: 20, label_zh: '渐入佳境', label_en: 'Getting Along' },
  { id: 'bond_trusted_partner', threshold: 40, label_zh: '信赖伙伴', label_en: 'Trusted Partner' },
  { id: 'bond_old_friend', threshold: 60, label_zh: '莫逆之交', label_en: 'Old Friend' },
  { id: 'bond_soulmate', threshold: 80, label_zh: '心意相通', label_en: 'Soulmates' },
  { id: 'bond_unbreakable', threshold: 95, label_zh: '坚不可摧', label_en: 'Unbreakable' },
]

export const BOND_MILESTONE_IDS = BOND_MILESTONES.map(m => m.id)

export type BondMilestoneId = (typeof BOND_MILESTONES)[number]['id']

export function isBondMilestoneId(id: string): id is BondMilestoneId {
  return (BOND_MILESTONE_IDS as readonly string[]).includes(id)
}

/** 羁绊度量数据 */
export interface BondMetrics {
  /** 综合羁绊值 (0-100) */
  level: number
  /** 信任阶段 */
  trustLevel: BondTrustLevel
  /** 相伴天数 */
  daysTogether: number
  /** 累计完成任务数 */
  tasksCompleted: number
  /** 当前执行模式 */
  executionMode: string
  /** 已达成的羁绊里程碑 */
  milestones: string[]
  /** 上次计算时间 */
  lastCalculatedAt: number
}
