/**
 * HTML 产出物预览 webview 的客页 preload。
 * 只做桥：主世界把选区报告过来，宿主把钉住/清除命令送回去。
 * 必须 contextIsolation，禁止把 Node 泄漏给预览页。
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'

const HOST_CHANNEL = 'sf-html-selection'
const CMD_CHANNEL = 'sf-html-selection-cmd'

contextBridge.exposeInMainWorld('__sfArtifactHost', {
  post(data: unknown) {
    ipcRenderer.sendToHost(HOST_CHANNEL, data)
  }
})

ipcRenderer.on(CMD_CHANNEL, (_event, cmd) => {
  const op = cmd && typeof cmd === 'object' ? (cmd as { op?: unknown }).op : null
  if (op !== 'pin' && op !== 'clear') return
  void webFrame.executeJavaScript(
    `window.__sfArtifactGuest&&window.__sfArtifactGuest.handle(${JSON.stringify({ op })})`
  )
})
