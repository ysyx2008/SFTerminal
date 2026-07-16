/**
 * IM 过程消息投递模式（前后端共用）。
 *
 * 三态语义见 IMServiceConfig.processMode 字段注释（electron/services/im/types.ts）。
 * 'messages' 是默认值，介于"完全静默"与"全量噪音"之间：
 * 用户能看到 AI 的对话节奏，但不被工具调用记录刷屏，也不逼微信触发风控。
 */
export type IMProcessMode = 'final' | 'messages' | 'all'

/**
 * 微信扫码登录过程状态（前后端共用）。
 * `qrcodeUrl` 是可编码为二维码的链接（非图片、非可 iframe 的网页）。
 */
export type WeChatLoginStatus =
  | { phase: 'qr'; qrcodeUrl: string }
  | { phase: 'scanned' }
  | { phase: 'refreshing' }
  | { phase: 'confirmed' }
  | { phase: 'error'; error: string }
