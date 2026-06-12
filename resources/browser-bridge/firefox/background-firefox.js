/**
 * Firefox background — browser.* API wrapper around shared logic
 */
const api = globalThis.browser || globalThis.chrome
const NATIVE_HOST = 'com.sailfish.browser'

/** @type {browser.runtime.Port | null} */
let nativePort = null

function connectNative() {
  if (nativePort) return
  try {
    nativePort = api.runtime.connectNative(NATIVE_HOST)
    const connectError = api.runtime.lastError
    if (connectError) {
      console.error('[SailFish Bridge] connectNative failed:', connectError.message)
      nativePort = null
      setTimeout(connectNative, 3000)
      return
    }
    nativePort.onMessage.addListener(onNativeMessage)
    nativePort.onDisconnect.addListener(() => {
      const disconnectError = api.runtime.lastError
      if (disconnectError) {
        console.error('[SailFish Bridge] native host disconnected:', disconnectError.message)
      }
      nativePort = null
      api.storage.local.set({ bridgeConnected: false })
      setTimeout(connectNative, 3000)
    })
    api.storage.local.set({ bridgeConnected: true })
  } catch (error) {
    console.error('[SailFish Bridge] connectNative failed', error)
    setTimeout(connectNative, 3000)
  }
}

async function onNativeMessage(message) {
  if (!message?.action) return
  const { id, action, payload = {} } = message
  try {
    const data = await dispatchAction(action, payload)
    nativePort?.postMessage({ id, success: true, data })
  } catch (error) {
    nativePort?.postMessage({ id, success: false, error: error.message || String(error) })
  }
}

async function dispatchAction(action, payload) {
  switch (action) {
    case 'ping':
      return { extension: 'sailfish-browser-bridge', version: api.runtime.getManifest().version }
    case 'list_tabs':
      return listTabs()
    case 'switch_tab':
      return switchTab(payload)
    case 'goto':
      return gotoUrl(payload)
    case 'close_tab':
      return closeTab(payload)
    case 'evaluate':
      return evaluateInActiveTab(payload)
    default:
      return runInActiveTab(action, payload)
  }
}

async function evaluateInActiveTab(payload) {
  const expression = String(payload.expression || '').trim()
  if (!expression) return { result: null }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  if (tab.url?.startsWith('about:')) {
    throw new Error(`Cannot evaluate on internal page: ${tab.url}`)
  }

  const worlds = ['ISOLATED', 'MAIN']
  let lastError = null
  for (const world of worlds) {
    try {
      const results = await api.scripting.executeScript({
        target: { tabId: tab.id },
        world,
        func: (code) => {
          let expr = code.trim()
          if (expr.startsWith('return ')) expr = expr.slice(7)
          try {
            return new Function(`return (${expr})`)()
          } catch (e1) {
            return new Function(expr)()
          }
        },
        args: [expression],
      })
      const entry = results?.[0]
      if (!entry) {
        lastError = new Error('Script injection returned no results')
        continue
      }
      if (entry.error) {
        lastError = new Error(String(entry.error))
        continue
      }
      return { result: entry.result }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  try {
    const fallback = await runInActiveTab('evaluate', payload)
    if (fallback && typeof fallback === 'object' && 'result' in fallback) return fallback
    return { result: fallback }
  } catch (error) {
    throw lastError || error
  }
}

async function listTabs() {
  const tabs = await api.tabs.query({ currentWindow: true })
  const active = tabs.find((t) => t.active)
  return tabs.map((tab, index) => ({
    index,
    id: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.id === active?.id,
  }))
}

async function switchTab(payload) {
  const index = Number(payload.index)
  const tabs = await api.tabs.query({ currentWindow: true })
  const tab = tabs[index]
  if (!tab?.id) throw new Error(`Tab index ${index} not found`)
  await api.tabs.update(tab.id, { active: true })
  await api.windows.update(tab.windowId, { focused: true })
  return { index, id: tab.id, url: tab.url, title: tab.title }
}

async function gotoUrl(payload) {
  const url = String(payload.url || '')
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  await api.tabs.update(tab.id, { url })
  await waitTabComplete(tab.id)
  const updated = await api.tabs.get(tab.id)
  return { url: updated.url, title: updated.title }
}

async function closeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) await api.tabs.remove(tab.id)
  return { closed: true }
}

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.tabs.onUpdated.removeListener(listener)
      reject(new Error('Navigation timeout'))
    }, timeoutMs)
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer)
        api.tabs.onUpdated.removeListener(listener)
        resolve(undefined)
      }
    }
    api.tabs.onUpdated.addListener(listener)
  })
}

async function runInActiveTab(action, payload) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  if (tab.url?.startsWith('about:')) {
    throw new Error(`Cannot operate on internal page: ${tab.url}`)
  }
  const results = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: (actionName, actionPayload) => {
      const handler = globalThis.__sailfishContentHandler
      if (!handler || typeof handler[actionName] !== 'function') {
        throw new Error(`Unknown content action: ${actionName}`)
      }
      return handler[actionName](actionPayload)
    },
    args: [action, payload],
  })
  const entry = results?.[0]
  if (!entry) {
    throw new Error('Script injection returned no results')
  }
  if (entry.error) {
    throw new Error(String(entry.error))
  }
  return entry.result
}

connectNative()
api.alarms.create('keepalive', { periodInMinutes: 1 })
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && nativePort) {
    nativePort.postMessage({ id: 'ping', action: 'ping', payload: {} })
  } else if (alarm.name === 'keepalive') {
    connectNative()
  }
})
