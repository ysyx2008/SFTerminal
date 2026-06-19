/**
 * 浏览器 Tab 通用原语 — Chromium / Firefox 共用（importScripts）
 * 桌面端通过 action `tabs` + op 组合策略；legacy goto/list_tabs/switch_tab 内部委托此处。
 */
(function () {
  function waitTabComplete(tabs, tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tabs.onUpdated.removeListener(listener)
        reject(new Error('Navigation timeout'))
      }, timeoutMs)
      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer)
          tabs.onUpdated.removeListener(listener)
          resolve(undefined)
        }
      }
      tabs.onUpdated.addListener(listener)
    })
  }

  function formatTabInfo(tab, index, activeId) {
    return {
      index: index >= 0 ? index : undefined,
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.id === activeId,
    }
  }

  async function resolveTabId(tabs, payload) {
    if (payload.tabId != null) return Number(payload.tabId)
    if (payload.index != null) {
      const list = await tabs.query({ currentWindow: true })
      const tab = list[Number(payload.index)]
      if (!tab?.id) throw new Error(`Tab index ${payload.index} not found`)
      return tab.id
    }
    const [tab] = await tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('No active tab')
    return tab.id
  }

  async function handleTabsOp(tabs, windows, payload) {
    const op = String(payload.op || '')
    switch (op) {
      case 'query': {
        const queryInfo =
          payload.query && typeof payload.query === 'object' ? payload.query : { currentWindow: true }
        const tabList = await tabs.query(queryInfo)
        const active = tabList.find((t) => t.active)
        return tabList.map((tab, index) => formatTabInfo(tab, index, active?.id))
      }
      case 'create': {
        const props = { active: payload.active !== false }
        if (payload.url) props.url = String(payload.url)
        if (payload.index != null) props.index = Number(payload.index)
        if (payload.windowId != null) props.windowId = Number(payload.windowId)
        const tab = await tabs.create(props)
        if (payload.wait !== false && payload.url) {
          await waitTabComplete(tabs, tab.id)
          const updated = await tabs.get(tab.id)
          return { ...formatTabInfo(updated, -1, updated.id), new_tab: true, created: true }
        }
        return { ...formatTabInfo(tab, -1, tab.id), new_tab: true, created: true }
      }
      case 'update': {
        const tabId = await resolveTabId(tabs, payload)
        const updateProps = {}
        if (payload.url != null) updateProps.url = String(payload.url)
        if (payload.active != null) updateProps.active = Boolean(payload.active)
        if (!Object.keys(updateProps).length) {
          throw new Error('tabs.update requires url and/or active')
        }
        await tabs.update(tabId, updateProps)
        if (payload.wait !== false && payload.url) {
          await waitTabComplete(tabs, tabId)
        }
        const updated = await tabs.get(tabId)
        return { ...formatTabInfo(updated, -1, updated.id), new_tab: false, updated_nav: true }
      }
      case 'activate': {
        const tabId = await resolveTabId(tabs, payload)
        const tab = await tabs.get(tabId)
        await tabs.update(tabId, { active: true })
        if (windows && tab.windowId != null) {
          await windows.update(tab.windowId, { focused: true })
        }
        const updated = await tabs.get(tabId)
        const list = await tabs.query({ currentWindow: true })
        const index = list.findIndex((t) => t.id === tabId)
        return {
          index: index >= 0 ? index : Number(payload.index),
          id: updated.id,
          url: updated.url || '',
          title: updated.title || '',
        }
      }
      case 'remove': {
        const tabId = await resolveTabId(tabs, payload)
        await tabs.remove(tabId)
        return { removed: true, tabId }
      }
      default:
        throw new Error(`Unknown tabs op: ${op}`)
    }
  }

  async function listTabs(tabs) {
    return handleTabsOp(tabs, null, { op: 'query', query: { currentWindow: true } })
  }

  async function gotoUrl(tabs, payload) {
    const url = String(payload.url || '')
    if (!url) throw new Error('url is required')
    if (payload.new_tab !== false) {
      const r = await handleTabsOp(tabs, null, { op: 'create', url, active: true, wait: true })
      return { url: r.url, title: r.title, new_tab: true }
    }
    const r = await handleTabsOp(tabs, null, { op: 'update', url, wait: true })
    return { url: r.url, title: r.title, new_tab: false }
  }

  async function switchTab(tabs, windows, payload) {
    return handleTabsOp(tabs, windows, { op: 'activate', index: Number(payload.index) })
  }

  async function closeTab(tabs, payload) {
    await handleTabsOp(tabs, null, { op: 'remove', ...payload })
    return { closed: true }
  }

  globalThis.__sailfishTabsApi = {
    handleTabsOp,
    listTabs,
    gotoUrl,
    switchTab,
    closeTab,
    waitTabComplete,
  }
})()
