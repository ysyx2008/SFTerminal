/**
 * Firefox background — browser.* API wrapper around shared tabs-api
 * tabs-api.js 由 manifest background.scripts 先行加载（比 importScripts 在 Firefox 临时加载更稳）
 */
const api = globalThis.browser || globalThis.chrome
const tabsApi = globalThis.__sailfishTabsApi
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
  if (!message) return
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.success) resolve(message.data)
    else reject(new Error(message.error || 'Unknown error'))
    return
  }
  if (!message.action) return
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
      return {
        extension: 'sailfish-browser-bridge',
        version: api.runtime.getManifest().version,
        protocol: 1,
        capabilities: ['tabs_manage', 'goto_new_tab'],
      }
    case 'tabs':
      return tabsApi.handleTabsOp(api.tabs, api.windows, payload)
    case 'list_tabs':
      return tabsApi.listTabs(api.tabs)
    case 'switch_tab':
      return tabsApi.switchTab(api.tabs, api.windows, payload)
    case 'goto':
      return tabsApi.gotoUrl(api.tabs, payload)
    case 'close_tab':
      return tabsApi.closeTab(api.tabs, payload)
    case 'reload':
      api.runtime.reload()
      return { reloaded: true }
    case 'evaluate':
      return evaluateViaMessage(payload)
    default:
      return runInActiveTab(action, payload)
  }
}

async function evaluateViaMessage(payload) {
  const expression = String(payload.expression || '').trim()
  if (!expression) return { result: null }
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  if (tab.url?.startsWith('about:')) {
    throw new Error(`Cannot evaluate on internal page: ${tab.url}`)
  }
  try {
    const response = await api.tabs.sendMessage(tab.id, {
      type: 'sailfish-evaluate',
      expression,
    })
    if (!response?.success) {
      throw new Error(response?.error || 'Evaluate failed')
    }
    return response.data
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Could not establish connection') || msg.includes('Receiving end does not exist')) {
      throw new Error('Content script not ready. Refresh the page and retry evaluate.')
    }
    throw error
  }
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

/** @type {Map<string, { resolve: Function, reject: Function }>} */
const pending = new Map()

function requestNative(action, payload) {
  return new Promise((resolve, reject) => {
    if (!nativePort) connectNative()
    if (!nativePort) {
      reject(new Error('Native host not connected'))
      return
    }
    const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pending.set(id, { resolve, reject })
    nativePort.postMessage({ id, action, payload })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`Timeout: ${action}`))
      }
    }, 60000)
  })
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source === 'sailfish-popup-test') {
    requestNative(message.action, message.payload)
      .then(sendResponse)
      .catch((e) => {
        reconnectNative()
        sendResponse({ error: e.message })
      })
    return true
  }
})

api.runtime.onStartup.addListener(() => {
  if (!nativePort) connectNative()
})

api.runtime.onInstalled.addListener(() => {
  if (!nativePort) connectNative()
})

function reconnectNative() {
  if (nativePort) {
    try { nativePort.disconnect() } catch { /* ignore */ }
    nativePort = null
  }
  api.storage.local.set({ bridgeConnected: false })
  setTimeout(connectNative, 1000)
}

connectNative()
api.alarms.create('keepalive', { periodInMinutes: 1 })
api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepalive') return
  if (!nativePort) {
    connectNative()
    return
  }
  try {
    await requestNative('ping', {})
  } catch {
    reconnectNative()
  }
})
