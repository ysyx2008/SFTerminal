const api = globalThis.browser || globalThis.chrome
const statusEl = document.getElementById('status')
const permPanel = document.getElementById('perm-panel')
const grantBtn = document.getElementById('grant-btn')
const ALL_URLS_ORIGIN = '<all_urls>'

function show(text, kind) {
  statusEl.textContent = text
  statusEl.className = kind
}

async function hasHostPermission() {
  try {
    return await api.permissions.contains({ origins: [ALL_URLS_ORIGIN] })
  } catch {
    return true
  }
}

async function requestHostPermission() {
  try {
    return await api.permissions.request({ origins: [ALL_URLS_ORIGIN] })
  } catch {
    return false
  }
}

async function checkConnection() {
  const resp = await api.runtime.sendMessage({
    source: 'sailfish-popup-test',
    action: 'ping',
    payload: {},
  })
  if (resp && !resp.error && resp.extension) {
    if (resp.hostPermissionsGranted === false) {
      show('Connected to SailFish, but site access is off', 'warn')
      return false
    }
    show('Connected to SailFish', 'ok')
    return true
  }
  const msg = resp?.error || 'Not connected'
  show(
    msg.includes('gateway') || msg.includes('Timeout') || msg.includes('not connected')
      ? 'SailFish not reachable — open SailFish app'
      : `Not connected — ${msg}`,
    'bad',
  )
  return false
}

function showPermissionPanel(showPanel) {
  permPanel.classList.toggle('hidden', !showPanel)
}

async function refresh() {
  show('Checking…', 'ok')
  showPermissionPanel(false)
  grantBtn.disabled = false

  const granted = await hasHostPermission()
  if (!granted) {
    show('Site access required', 'warn')
    showPermissionPanel(true)
    return
  }

  try {
    await checkConnection()
  } catch (e) {
    show(
      e?.message?.includes('native host')
        ? 'Not connected — open SailFish Settings → Browser Assistant'
        : 'Not connected — open SailFish Settings → Browser Assistant',
      'bad',
    )
  }
}

grantBtn.addEventListener('click', async () => {
  grantBtn.disabled = true
  show('Requesting permission…', 'ok')
  const granted = await requestHostPermission()
  if (!granted) {
    show('Permission denied — enable in about:addons → Permissions', 'bad')
    grantBtn.disabled = false
    showPermissionPanel(true)
    return
  }
  await refresh()
})

refresh()
