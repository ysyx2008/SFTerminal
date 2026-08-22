/**
 * 应用级偏好：用户在设置里选、主进程与界面都要认的那几项。
 */

/** 界面语言 */
export type LocaleType = 'zh-CN' | 'en-US'

/** 日志级别（主进程与渲染进程各有各的 logger 实现，级别口径必须一致） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** 更新源 */
export type UpdateSource = 'github' | 'oss'
