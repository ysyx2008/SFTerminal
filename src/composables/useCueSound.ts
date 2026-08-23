import { clampCueVolume, DEFAULT_CUE_SOUND_SETTINGS, isCueKindEnabled, type CueSoundKind, type CueSoundSettings } from '@shared/types'
import completeUrl from '../../resources/sounds/cue-complete.wav'
import failedUrl from '../../resources/sounds/cue-failed.wav'
import confirmUrl from '../../resources/sounds/cue-confirm.wav'
import messageUrl from '../../resources/sounds/cue-message.wav'
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
  message: messageUrl,
}

const DEBOUNCE_MS = 450
const lastPlayedAt: Partial<Record<CueSoundKind, number>> = {}
let current: HTMLAudioElement | null = null
let cueCtx: AudioContext | null = null
let lastSource: MediaElementAudioSourceNode | null = null
let lastGain: GainNode | null = null

function cueAudioContext(): AudioContext | null {
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!cueCtx) cueCtx = new Ctor()
  if (cueCtx.state === 'suspended') void cueCtx.resume()
  return cueCtx
}

function teardownCueGraph(): void {
  lastSource?.disconnect()
  lastGain?.disconnect()
  lastSource = null
  lastGain = null
}

function settings(): CueSoundSettings {
  return useConfigStore().cueSoundSettings ?? DEFAULT_CUE_SOUND_SETTINGS
}

function resolveUrl(kind: CueSoundKind, s: CueSoundSettings): string {
  const custom = s.custom[kind]
  return custom && custom.startsWith('data:') ? custom : DEFAULT_URLS[kind]
}

export function playCueSound(kind: CueSoundKind, opts?: { force?: boolean }): void {
  const s = settings()
  if (!opts?.force && !isCueKindEnabled(kind, s)) return

  const now = Date.now()
  if (!opts?.force && lastPlayedAt[kind] && now - lastPlayedAt[kind]! < DEBOUNCE_MS) return
  lastPlayedAt[kind] = now

  if (current) {
    current.pause()
    current = null
  }
  teardownCueGraph()

  const audio = new Audio(resolveUrl(kind, s))
  const volume = clampCueVolume(s.volume)
  const ctx = cueAudioContext()
  if (ctx) {
    lastSource = ctx.createMediaElementSource(audio)
    lastGain = ctx.createGain()
    lastGain.gain.value = volume
    lastSource.connect(lastGain)
    lastGain.connect(ctx.destination)
  } else {
    audio.volume = Math.min(1, volume)
  }
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

export function notifyCompanionMessageCue(): void {
  playCueSound('message')
}
