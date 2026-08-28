/**
 * 这场对话开着的技能（输入区胶囊）。
 * 真相在后端；这里只做展示和把用户的点上/点掉交出去。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { useTerminalStore } from './terminal'

export interface ConversationSkillChip {
  id: string
  name: string
  description?: string
}

function isMcpSkillId(id: string): boolean {
  return id.startsWith('mcp:')
}

export const useConversationSkillsStore = defineStore('conversationSkills', () => {
  const skillsByTabId = ref<Record<string, ConversationSkillChip[]>>({})
  const justAddedByTabId = ref<Record<string, string[]>>({})
  let listening = false
  let stopListen: (() => void) | null = null

  function resolveAgentKey(tabId: string): string | null {
    if (!tabId || tabId === WELCOME_COMPOSER_TAB_ID) return null
    const terminalStore = useTerminalStore()
    const tab = terminalStore.tabs.find(t => t.id === tabId)
    if (!tab) return tabId
    if (tab.type === 'assistant') return tab.agentId || tab.id
    return tab.id
  }

  function resolveTabId(agentKey: string): string | undefined {
    const terminalStore = useTerminalStore()
    return terminalStore.findTabIdByAgentId(agentKey)
      ?? terminalStore.tabs.find(t => t.id === agentKey)?.id
  }

  function getSkills(tabId: string): ConversationSkillChip[] {
    return skillsByTabId.value[tabId] ?? []
  }

  function justAddedIds(tabId: string): string[] {
    return justAddedByTabId.value[tabId] ?? []
  }

  function applySnapshot(tabId: string, skills: ConversationSkillChip[], animateNew: boolean): void {
    const visible = skills.filter(s => !isMcpSkillId(s.id))
    const prev = new Set((skillsByTabId.value[tabId] ?? []).map(s => s.id))
    const added = visible.filter(s => !prev.has(s.id)).map(s => s.id)
    skillsByTabId.value = { ...skillsByTabId.value, [tabId]: visible }
    if (animateNew && added.length > 0) {
      justAddedByTabId.value = { ...justAddedByTabId.value, [tabId]: added }
      window.setTimeout(() => {
        const current = justAddedByTabId.value[tabId] ?? []
        justAddedByTabId.value = {
          ...justAddedByTabId.value,
          [tabId]: current.filter(id => !added.includes(id))
        }
      }, 1400)
    }
  }

  function hydrateFromRecord(tabId: string, loadedSkills?: string[]): void {
    const visible = (loadedSkills ?? []).filter(id => !isMcpSkillId(id))
    applySnapshot(tabId, visible.map(id => ({ id, name: id })), false)
  }

  function clearTab(tabId: string): void {
    const next = { ...skillsByTabId.value }
    delete next[tabId]
    skillsByTabId.value = next
  }

  function transferWelcomeSkills(toTabId: string): ConversationSkillChip[] {
    const chips = getSkills(WELCOME_COMPOSER_TAB_ID)
    if (chips.length > 0) {
      applySnapshot(toTabId, chips, false)
    }
    clearTab(WELCOME_COMPOSER_TAB_ID)
    return chips
  }

  async function pin(tabId: string, skill: ConversationSkillChip): Promise<boolean> {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      const cur = getSkills(tabId)
      if (cur.some(s => s.id === skill.id)) return true
      applySnapshot(tabId, [...cur, skill], true)
      return true
    }
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return false
    const result = await window.electronAPI.agent.pinSkill(agentKey, skill.id)
    if (result.ok) {
      applySnapshot(tabId, result.skills, true)
      return true
    }
    return false
  }

  async function unpin(tabId: string, skillId: string): Promise<void> {
    if (tabId === WELCOME_COMPOSER_TAB_ID) {
      applySnapshot(tabId, getSkills(tabId).filter(s => s.id !== skillId), false)
      return
    }
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const result = await window.electronAPI.agent.unpinSkill(agentKey, skillId)
    applySnapshot(tabId, result.skills, false)
  }

  async function sync(tabId: string): Promise<void> {
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const skills = await window.electronAPI.agent.getVisibleSkills(agentKey)
    // Agent 还没建起来时是空列表，不等于这场对话没技能。
    // 打开历史时先从记录画上胶囊，再被这次空结果抹掉。
    if (skills.length === 0) return
    applySnapshot(tabId, skills, false)
  }

  async function hydrateBackend(tabId: string, loadedSkills?: string[], userDismissedSkills?: string[]): Promise<void> {
    const agentKey = resolveAgentKey(tabId)
    if (!agentKey) return
    const skills = await window.electronAPI.agent.hydrateSkills(agentKey, loadedSkills, userDismissedSkills)
    applySnapshot(tabId, skills, false)
  }

  function startListening(): void {
    if (listening) return
    listening = true
    stopListen = window.electronAPI.agent.onSkillsChanged((data) => {
      const tabId = resolveTabId(data.agentId)
      if (!tabId) return
      applySnapshot(tabId, data.skills, true)
    })
  }

  function stopListening(): void {
    stopListen?.()
    stopListen = null
    listening = false
  }

  return {
    getSkills,
    justAddedIds,
    hydrateFromRecord,
    hydrateBackend,
    clearTab,
    transferWelcomeSkills,
    pin,
    unpin,
    sync,
    startListening,
    stopListening
  }
})
