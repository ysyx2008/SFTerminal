/**
 * 设置页的「有未保存改动」守卫。
 *
 * 面板里绝大多数设置是改完即存的，但少数几页（风险策略这类危险设置）刻意要求
 * 用户显式点保存。这些页原先只在自己内部的切换处拦一道，从侧栏点走则无声丢弃
 * ——被保护的恰好是最不可能的那条出口。
 *
 * 这里把「谁脏了」收到面板根上：页面登记自己的脏判断，侧栏切换前统一问一次。
 * 同一时刻只有一个设置页在显示，所以只需要记住一个判断函数。
 */
import { inject, provide, onBeforeUnmount, type InjectionKey, type Ref } from 'vue'

type DirtyFn = () => boolean

type UnsavedGuard = {
  set: (fn: DirtyFn) => void
  /** 只在登记的还是自己时才撤销——页面切换时新页可能先挂载、旧页后卸载 */
  clearIf: (fn: DirtyFn) => void
}

const KEY: InjectionKey<UnsavedGuard> = Symbol('settings-unsaved-guard')

/** 面板根调用：拿到「当前页是否有未保存改动」的查询口 */
export function provideUnsavedGuard() {
  let current: DirtyFn | null = null
  provide(KEY, {
    set: fn => { current = fn },
    clearIf: fn => { if (current === fn) current = null },
  })
  return {
    hasUnsaved: () => current?.() === true,
    reset: () => { current = null },
  }
}

/** 设置页调用：登记自己的未保存状态 */
export function useUnsavedGuard(isDirty: Ref<boolean>) {
  const guard = inject(KEY, null)
  if (!guard) return
  const mine: DirtyFn = () => isDirty.value
  guard.set(mine)
  onBeforeUnmount(() => guard.clearIf(mine))
}
