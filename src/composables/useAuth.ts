/**
 * SSO 组合式 API（desktop 实现；岗包经 @sailfish/workbench-sdk/auth 引用）
 */
import { storeToRefs } from 'pinia'
import { useAuthStore } from '../stores/auth'

export function useAuth() {
  const store = useAuthStore()
  const {
    enabled,
    gateMode,
    user,
    isAuthenticated,
    loading,
    error,
    blockApp,
    showSoftEntry,
  } = storeToRefs(store)

  return {
    enabled,
    gateMode,
    user,
    isAuthenticated,
    loading,
    error,
    blockApp,
    showSoftEntry,
    init: () => store.init(),
    login: () => store.login(),
    logout: () => store.logout(),
    getAccessToken: () => store.getAccessToken(),
  }
}
