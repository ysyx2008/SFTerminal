const statusEl = document.getElementById('status')
chrome.storage.local.get(['bridgeConnected'], (data) => {
  if (data.bridgeConnected) {
    statusEl.textContent = 'Connected to SailFish'
    statusEl.className = 'ok'
  } else {
    statusEl.textContent = 'Not connected — open SailFish Settings → Browser Assistant'
    statusEl.className = 'bad'
  }
})
