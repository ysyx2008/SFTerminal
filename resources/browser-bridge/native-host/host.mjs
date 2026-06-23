/**
 * Native Messaging Host — 扩展与 SailFish Electron 网关之间的桥接
 * 启动：Chrome 按 connectNative 拉起；首参为扩展 origin
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolveNativeHostOrigin } from './resolve-origin.mjs'

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
const ORIGIN = resolveNativeHostOrigin(process.argv[2])
const HOST_NAME = 'com.sailfish.browser'

let stdinBuffer = Buffer.alloc(0)
let tcpBuffer = Buffer.alloc(0)
/** @type {import('node:net').Socket | null} */
let gatewaySocket = null
let gatewayConfig = null
let reconnectTimer = null
let reconnectAttempts = 0
let lastGatewayPort = null
// After ~30 s of failed reconnects, exit so Firefox restarts us with fresh gateway config
const MAX_RECONNECT_ATTEMPTS = 20

function log(...args) {
  console.error(`[${HOST_NAME}]`, ...args)
}

function debugLog(message) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
    fs.appendFileSync(path.join(home, '.sailfish-host.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // ignore
  }
}

debugLog(`host started argv=${JSON.stringify(process.argv)}`)

function resolveGatewayFile() {
  if (process.env.SAILFISH_BROWSER_BRIDGE_GATEWAY) {
    return process.env.SAILFISH_BROWSER_BRIDGE_GATEWAY
  }

  const envJson = path.join(HOST_DIR, 'host-env.json')
  if (fs.existsSync(envJson)) {
    try {
      const env = JSON.parse(fs.readFileSync(envJson, 'utf8'))
      if (env.SAILFISH_BROWSER_BRIDGE_GATEWAY && fs.existsSync(env.SAILFISH_BROWSER_BRIDGE_GATEWAY)) {
        return env.SAILFISH_BROWSER_BRIDGE_GATEWAY
      }
    } catch {
      // ignore
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || ''
  const pointerPath = home ? path.join(home, '.sailfish-browser-bridge.json') : ''
  if (pointerPath && fs.existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
      if (pointer.gatewayFile && fs.existsSync(pointer.gatewayFile)) {
        return pointer.gatewayFile
      }
      if (pointer.bridgeRoot) {
        const fromPointer = path.join(pointer.bridgeRoot, 'gateway.json')
        if (fs.existsSync(fromPointer)) return fromPointer
      }
    } catch {
      // ignore
    }
  }

  const scanned = scanForGatewayFile(home)
  if (scanned) return scanned

  return path.join(HOST_DIR, '..', 'gateway.json')
}

function isValidBridgeGateway(gatewayFile) {
  const bridgeRoot = path.dirname(gatewayFile)
  return fs.existsSync(path.join(bridgeRoot, 'native-host', 'host.mjs'))
}

function gatewayScore(gatewayFile) {
  try {
    const cfg = JSON.parse(fs.readFileSync(gatewayFile, 'utf8'))
    if (typeof cfg.updatedAt === 'number') return cfg.updatedAt
  } catch {
    // ignore
  }
  try {
    return fs.statSync(gatewayFile).mtimeMs
  } catch {
    return 0
  }
}

function scanForGatewayFile(home) {
  if (!home) return null
  const candidates = []

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support')
    if (fs.existsSync(appSupport)) {
      for (const entry of fs.readdirSync(appSupport)) {
        candidates.push(path.join(appSupport, entry, 'browser-bridge', 'gateway.json'))
      }
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    if (fs.existsSync(appData)) {
      for (const entry of fs.readdirSync(appData)) {
        candidates.push(path.join(appData, entry, 'browser-bridge', 'gateway.json'))
      }
    }
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    if (fs.existsSync(configHome)) {
      for (const entry of fs.readdirSync(configHome)) {
        candidates.push(path.join(configHome, entry, 'browser-bridge', 'gateway.json'))
      }
    }
  }

  let best = null
  let bestScore = -1
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !isValidBridgeGateway(candidate)) continue
    const score = gatewayScore(candidate)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

function readGatewayConfig() {
  const file = resolveGatewayFile()
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    log('Failed to read gateway config:', error.message)
    return null
  }
}

function writeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  process.stdout.write(header)
  process.stdout.write(json)
}

function parseLengthPrefixed(buffer, onMessage) {
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    if (length <= 0 || length > 64 * 1024 * 1024) {
      throw new Error(`Invalid message length: ${length}`)
    }
    if (offset + 4 + length > buffer.length) break
    const body = buffer.subarray(offset + 4, offset + 4 + length)
    offset += 4 + length
    try {
      onMessage(JSON.parse(body.toString('utf8')))
    } catch (error) {
      log('Invalid JSON from stream:', error.message)
    }
  }
  return buffer.subarray(offset)
}

function connectGateway() {
  gatewayConfig = readGatewayConfig()
  debugLog(`gateway file=${resolveGatewayFile()} config=${gatewayConfig ? 'ok' : 'missing'}`)
  if (!gatewayConfig?.port) {
    scheduleReconnect(2000)
    return
  }

  if (gatewayConfig.port !== lastGatewayPort) {
    lastGatewayPort = gatewayConfig.port
    reconnectAttempts = 0
    debugLog(`gateway port changed, reset reconnect counter to ${lastGatewayPort}`)
  }

  const socket = net.createConnection({ host: '127.0.0.1', port: gatewayConfig.port }, () => {
    gatewaySocket = socket
    reconnectAttempts = 0
    debugLog(`tcp connected port=${gatewayConfig.port} origin=${ORIGIN}`)
    socket.write(`${JSON.stringify({
      type: 'host_register',
      origin: ORIGIN,
      host: HOST_NAME,
      token: gatewayConfig.token,
    })}\n`)
  })

  socket.on('data', (chunk) => {
    debugLog(`tcp data len=${chunk.length}`)
    tcpBuffer = Buffer.concat([tcpBuffer, chunk])
    let idx
    while ((idx = tcpBuffer.indexOf(10)) >= 0) {
      const line = tcpBuffer.subarray(0, idx).toString('utf8').trim()
      tcpBuffer = tcpBuffer.subarray(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'extension_message' && msg.message) {
          writeNativeMessage(msg.message)
        }
      } catch (error) {
        log('Invalid gateway line:', error.message)
      }
    }
  })

  socket.on('close', (hadError) => {
    debugLog(`tcp closed hadError=${hadError} origin=${ORIGIN}`)
    if (gatewaySocket === socket) gatewaySocket = null
    scheduleReconnect(1500)
  })

  socket.on('error', (error) => {
    debugLog(`tcp error: ${error.message}`)
    log('Gateway socket error:', error.message)
  })
}

function scheduleReconnect(ms) {
  if (reconnectTimer) return
  reconnectAttempts++
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    // Gateway unreachable for ~30 s. Exit so Firefox restarts us and we pick up fresh gateway config.
    debugLog(`too many reconnect attempts (${reconnectAttempts}), exiting to force restart`)
    process.exit(0)
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectGateway()
  }, ms)
}

function forwardToGateway(message) {
  if (!gatewaySocket || gatewaySocket.destroyed) {
    writeNativeMessage({
      id: message.id,
      success: false,
      error: 'SailFish gateway not connected. Open SailFish and enable Browser Assistant in Settings.',
    })
    return
  }
  gatewaySocket.write(`${JSON.stringify({
    type: 'extension_message',
    origin: ORIGIN,
    message,
  })}\n`)
}

process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk])
  try {
    stdinBuffer = parseLengthPrefixed(stdinBuffer, forwardToGateway)
  } catch (error) {
    log(error.message)
    process.exit(1)
  }
})

process.stdin.on('end', () => {
  if (gatewaySocket) gatewaySocket.end()
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

connectGateway()
