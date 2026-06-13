const NATIVE_HOST = 'com.sailfish.browser'

/** @type {chrome.runtime.Port | null} */
let nativePort = null
/** @type {Map<string, { resolve: Function, reject: Function }>} */
const pending = new Map()
let reconnectTimer = null

function connectNative() {
  if (nativePort) return
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST)
    const connectError = chrome.runtime.lastError
    if (connectError) {
      console.error('[SailFish Bridge] connectNative failed:', connectError.message)
      nativePort = null
      scheduleReconnect()
      return
    }
    nativePort.onMessage.addListener(onNativeMessage)
    nativePort.onDisconnect.addListener(() => {
      const disconnectError = chrome.runtime.lastError
      if (disconnectError) {
        console.error('[SailFish Bridge] native host disconnected:', disconnectError.message)
      }
      nativePort = null
      chrome.storage.local.set({ bridgeConnected: false })
      scheduleReconnect()
    })
    chrome.storage.local.set({ bridgeConnected: true })
  } catch (error) {
    console.error('[SailFish Bridge] connectNative failed', error)
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectNative()
  }, 3000)
}

function onNativeMessage(message) {
  if (message?.type === 'ping') {
    nativePort?.postMessage({ id: message.id, success: true, data: { pong: true } })
    return
  }
  if (message?.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.success) resolve(message.data)
    else reject(new Error(message.error || 'Unknown error'))
    return
  }
  if (message?.action) {
    handleHostCommand(message).catch((error) => {
      nativePort?.postMessage({
        id: message.id,
        success: false,
        error: error.message || String(error),
      })
    })
  }
}

async function handleHostCommand(message) {
  const { id, action, payload = {} } = message
  try {
    const data = await dispatchAction(action, payload)
    nativePort?.postMessage({ id, success: true, data })
  } catch (error) {
    nativePort?.postMessage({
      id,
      success: false,
      error: error.message || String(error),
    })
  }
}

async function dispatchAction(action, payload) {
  switch (action) {
    case 'ping':
      return {
        extension: 'sailfish-browser-bridge',
        version: chrome.runtime.getManifest().version,
        protocol: 1,
      }
    case 'list_tabs':
      return listTabs()
    case 'switch_tab':
      return switchTab(payload)
    case 'goto':
      return gotoUrl(payload)
    case 'close_tab':
      return closeTab(payload)
    case 'evaluate':
      return evaluateViaMessage(payload)
    default:
      return runInActiveTab(action, payload)
  }
}

async function evaluateViaMessage(payload) {
  const expression = String(payload.expression || '').trim()
  if (!expression) return { result: null }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
    throw new Error(`Cannot evaluate on internal page: ${tab.url}`)
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
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

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true })
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
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const tab = tabs[index]
  if (!tab?.id) throw new Error(`Tab index ${index} not found`)
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  return { index, id: tab.id, url: tab.url, title: tab.title }
}

async function gotoUrl(payload) {
  const url = String(payload.url || '')
  if (!url) throw new Error('url is required')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  await chrome.tabs.update(tab.id, { url })
  await waitTabComplete(tab.id)
  const updated = await chrome.tabs.get(tab.id)
  return { url: updated.url, title: updated.title }
}

async function closeTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) await chrome.tabs.remove(tab.id)
  return { closed: true }
}

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('Navigation timeout'))
    }, timeoutMs)
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve(undefined)
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function runInActiveTab(action, payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
    throw new Error(`Cannot operate on browser internal page: ${tab.url}`)
  }
  const results = await chrome.scripting.executeScript({
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source === 'sailfish-popup-test') {
    requestNative(message.action, message.payload).then(sendResponse).catch((e) => sendResponse({ error: e.message }))
    return true
  }
})

connectNative()
chrome.alarms.create('keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!nativePort) connectNative()
    else nativePort.postMessage({ id: 'ping', action: 'ping', payload: {} })
  }
})
