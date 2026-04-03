/**
 * OpenClaw Plugin SDK Shim
 * 
 * 让 OpenClaw 插件中的 `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"`
 * 能正确 resolve。definePluginEntry 本质是 identity 函数（提供 TS 类型推断），
 * 真正的 register(api) 由 SailFish 的 loader.ts 驱动。
 */

// definePluginEntry: 插件定义入口（identity function）
function definePluginEntry(entry) {
  return entry
}

// defineChannelPluginEntry: channel 插件定义入口
function defineChannelPluginEntry(entry) {
  return entry
}

// createPluginRuntimeStore: 运行时状态存储（no-op shim）
function createPluginRuntimeStore(_pluginId, _defaults) {
  const store = {}
  return {
    get(key) { return store[key] },
    set(key, value) { store[key] = value },
    getAll() { return { ...store } },
    clear() { Object.keys(store).forEach(k => delete store[k]) }
  }
}

module.exports = {
  definePluginEntry,
  defineChannelPluginEntry,
  createPluginRuntimeStore,
  default: {
    definePluginEntry,
    defineChannelPluginEntry,
    createPluginRuntimeStore
  }
}
