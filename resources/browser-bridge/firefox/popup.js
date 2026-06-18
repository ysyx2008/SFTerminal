const api = globalThis.browser || globalThis.chrome
const statusEl = document.getElementById('status')

function show(text, ok) {
  statusEl.textContent = text
  statusEl.className = ok ? 'ok' : 'bad'
}

show('Checking…', true)

api.runtime.sendMessage({ source: 'sailfish-popup-test', action: 'ping', payload: {} }).then((resp) => {
  if (resp && !resp.error && resp.extension) {
    show('Connected to SailFish', true)
  } else {
    const msg = resp?.error || 'Not connected'
    show(
      msg.includes('gateway') || msg.includes('Timeout') || msg.includes('not connected')
        ? 'SailFish not reachable — open SailFish app'
        : `Not connected — ${msg}`,
      false,
    )
  }
}).catch((e) => {
  show(
    e?.message?.includes('native host')
      ? 'Not connected — open SailFish Settings → Browser Assistant'
      : 'Not connected — open SailFish Settings → Browser Assistant',
    false,
  )
})
