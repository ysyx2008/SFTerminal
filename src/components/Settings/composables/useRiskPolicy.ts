/**
 * 命令风险策略的读写。
 *
 * 这份策略被两个设置页共同编辑：「命令规则」页管路径分区那几项（工作区外写要不要
 * 确认、额外自由区），「风险策略」页管各风险级别的处置矩阵。它们改的是同一个存储
 * 键，保存时也是整个对象一起写，所以加载、比对、保存这套东西只能有一份，
 * 否则两页各写一套判等逻辑，日后加字段必然漏掉其中一处。
 *
 * 每个页面各自调用一次，各持一份实例；进页面时重新加载，不跨页共享内存状态。
 */
import { ref, computed } from 'vue'
import type { CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'

export const DEFAULT_POLICY: CommandRiskPolicy = {
  ...DEFAULT_COMMAND_RISK_POLICY,
  extraFreeDirs: [],
}

export function clonePolicy(p: CommandRiskPolicy): CommandRiskPolicy {
  return { ...p, extraFreeDirs: [...p.extraFreeDirs] }
}

export function policiesEqual(a: CommandRiskPolicy, b: CommandRiskPolicy): boolean {
  return (
    a.strictParseFail === b.strictParseFail &&
    a.strictUnknownCmd === b.strictUnknownCmd &&
    a.strictIndirection === b.strictIndirection &&
    a.strictDynamicPath === b.strictDynamicPath &&
    a.relaxedParseFail === b.relaxedParseFail &&
    a.relaxedUnknownCmd === b.relaxedUnknownCmd &&
    a.relaxedIndirection === b.relaxedIndirection &&
    a.relaxedDynamicPath === b.relaxedDynamicPath &&
    a.relaxedConfirmModerate === b.relaxedConfirmModerate &&
    a.outsideWritesUpgrade === b.outsideWritesUpgrade &&
    a.subAgentBlockDangerous === b.subAgentBlockDangerous &&
    a.extraFreeDirs.length === b.extraFreeDirs.length &&
    a.extraFreeDirs.every((d, i) => d === b.extraFreeDirs[i])
  )
}

function mergePolicy(stored: Partial<CommandRiskPolicy> | null | undefined): CommandRiskPolicy {
  return {
    ...DEFAULT_POLICY,
    ...(stored || {}),
    extraFreeDirs: Array.isArray(stored?.extraFreeDirs)
      ? stored!.extraFreeDirs!.filter(d => typeof d === 'string' && d.trim())
      : [],
  }
}

export function useRiskPolicy() {
  const policy = ref<CommandRiskPolicy>(clonePolicy(DEFAULT_POLICY))
  /** 上次成功加载/保存的快照，用于判断未保存更改 */
  const savedPolicy = ref<CommandRiskPolicy>(clonePolicy(DEFAULT_POLICY))

  const loaded = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const justSaved = ref(false)
  const error = ref(false)

  /** 相对已保存快照是否有未保存修改 */
  const unsaved = computed(() => !policiesEqual(policy.value, savedPolicy.value))

  async function load() {
    loading.value = true
    error.value = false
    try {
      const stored = await window.electronAPI.config.get('commandRiskPolicy')
      const merged = mergePolicy(stored as Partial<CommandRiskPolicy> | null | undefined)
      policy.value = merged
      savedPolicy.value = clonePolicy(merged)
      loaded.value = true
    } catch {
      error.value = true
    } finally {
      loading.value = false
    }
  }

  async function save() {
    if (!unsaved.value || saving.value) return
    saving.value = true
    error.value = false
    try {
      await window.electronAPI.config.set('commandRiskPolicy', clonePolicy(policy.value))
      savedPolicy.value = clonePolicy(policy.value)
      justSaved.value = true
      setTimeout(() => { justSaved.value = false }, 2000)
    } catch {
      error.value = true
    } finally {
      saving.value = false
    }
  }

  return {
    policy,
    loaded,
    loading,
    saving,
    justSaved,
    error,
    unsaved,
    load,
    save,
  }
}
