import { DEFAULT_CUE_SOUND_SETTINGS, type CueSoundKind, type CueSoundSettings } from '@shared/types'
import completeUrl from '../../resources/sounds/cue-complete.wav'
import failedUrl from '../../resources/sounds/cue-failed.wav'
import confirmUrl from '../../resources/sounds/cue-confirm.wav'
import {
  resolveCompleteCueKind,
  shouldPlayConfirmCue,
  shouldPlayFailedCue,
} from '../utils/cue-sound-policy'
import { useConfigStore } from '../stores/config'

const DEFAULT_URLS: Record<CueSoundKind, string> = {
  complete: completeUrl,
  failed: failedUrl,
  confirm: confirmUrl,
}

const DEBOUNCE_MS = 450
const lastPlayedAt: Partial<Record<CueSoundKind, number>> = {}
let current: HTMLAudioElement | null = null

function settings(): CueSoundSettings {
  return useConfigStore().cueSoundSettings ?? DEFAULT_CUE_SOUND_SETTINGS
}

function resolveUrl(kind: CueSoundKind, s: CueSoundSettings): string {
  const custom = s.custom[kind]
  return custom && custom.startsWith('data:') ? custom : DEFAULT_URLS[kind]
}

export function playCueSound(kind: CueSoundKind, opts?: { force?: boolean }): void {
  const s = settings()
  if (!opts?.force && !s.enabled) return

  const now = Date.now()
  if (!opts?.force && lastPlayedAt[kind] && now - lastPlayedAt[kind]! < DEBOUNCE_MS) return
  lastPlayedAt[kind] = now

  if (current) {
    current.pause()
    current = null
  }
  const audio = new Audio(resolveUrl(kind, s))
  current = audio
  void audio.play().catch(() => {})
}

export function notifyAgentCompleteCue(agentKeys: Array<string | undefined>, aborted?: boolean): void {
  const kind = resolveCompleteCueKind(agentKeys, aborted)
  if (!kind) return
  playCueSound(kind)
}

export function notifyAgentFailedCue(agentKeys: Array<string | undefined>): void {
  if (!shouldPlayFailedCue(agentKeys)) return
  playCueSound('failed')
}

export function notifyAgentConfirmCue(agentKeys: Array<string | undefined>): void {
  if (!shouldPlayConfirmCue(agentKeys)) return
  playCueSound('confirm')
}
