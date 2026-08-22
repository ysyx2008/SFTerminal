/**
 * 定时任务。
 *
 * @deprecated 已整合进关切系统（见 watch），保留仅为兼容旧数据与旧界面。
 */

/** 任务执行状态 */
export type TaskRunStatus = 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'

/** 调度方式 */
export type ScheduleType = 'cron' | 'interval' | 'once'
