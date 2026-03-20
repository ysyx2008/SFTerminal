export interface BastionConfig {
  url: string
  username: string
  password: string
  autoJumpHost: boolean
  jumpHostPort: number
}

export interface BastionSyncResult {
  success: boolean
  error?: string
  added: number
  updated: number
  removed: number
  total: number
  groupId: string
  groupName: string
}
