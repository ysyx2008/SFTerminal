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
    nativePort.onMessage.addListener(onNativeMessage)
    nativePort.onDisconnect.addListener(() => {
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
    default:
      return runInActiveTab(action, payload)
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
  return results[0]?.result
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
