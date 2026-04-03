/**
 * OpenClaw SDK Module Resolution Shim
 * 
 * 使用 Module._resolveFilename 拦截 openclaw/plugin-sdk/* 的 import，
 * 重定向到本地 sdk-shim.js。复用 electron/cli/main.js 的成熟技巧。
 */

const Module = require('module')
const path = require('path')

const shimPath = path.join(__dirname, 'sdk-shim.js')
let registered = false

function register() {
  if (registered) return
  registered = true

  const origResolve = Module._resolveFilename

  Module._resolveFilename = function(request, parent, isMain, options) {
    // 拦截所有 openclaw/plugin-sdk 子路径
    if (typeof request === 'string' && request.startsWith('openclaw/plugin-sdk')) {
      return shimPath
    }
    // 拦截 openclaw 根包（部分插件可能用旧的 monolithic import）
    if (request === 'openclaw/plugin-sdk') {
      return shimPath
    }
    return origResolve.call(this, request, parent, isMain, options)
  }
}

module.exports = { register }
