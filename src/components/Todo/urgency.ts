/**
 * 待办紧迫度分档。
 *
 * 面板算出档位、悬浮提示按档位取色，两边靠 prop 相传——档位必须是同一份定义，
 * 各写一份的话改了一边不会有任何编译信号。
 */
export type UrgencyTier = 'urgent' | 'watch' | 'relaxed'
