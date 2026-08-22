/**
 * 桌面提示音：软槌击木/玻璃，暖、短、不刺耳。
 *
 * 原则（烦了就失败）：
 * - 音区落在中音，不往 1.2kHz 以上顶
 * - 高次谐波比基频死得快，避免廉价电蜂鸣
 * - 轻微失谐叠层，听着像实物而不是纯正弦
 * - 起音软、尾巴干净、音量偏轻
 *
 *   node scripts/generate-cue-sounds.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'resources', 'sounds')

const cents = (freq, c) => freq * 2 ** (c / 1200)

let rngState = 0xC0FFEE
function rand() {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0
  return rngState / 0x100000000
}

function raisedCos(t, attack) {
  if (t <= 0) return 0
  if (t >= attack) return 1
  return 0.5 - 0.5 * Math.cos(Math.PI * (t / attack))
}

/** 软槌：基频长、泛音短；双声轻微失谐 */
function mallet(t, freq, { attack, bodyTau, brightTau, air = 0.12 }) {
  if (t < 0) return 0
  const a = raisedCos(t, attack)
  const body = Math.exp(-t / bodyTau)
  const bright = Math.exp(-t / brightTau)
  const w = 2 * Math.PI * t
  const v1 = Math.sin(w * freq) + Math.sin(w * cents(freq, 5))
  const v2 = Math.sin(w * freq * 2.003) + Math.sin(w * cents(freq * 2, -4))
  const v3 = Math.sin(w * freq * 2.997)
  return a * (
    0.62 * v1 * body +
    0.16 * v2 * bright +
    0.05 * v3 * bright * bright +
    air * (rand() * 2 - 1) * bright * 0.045
  )
}

function lowpass(samples, cutoffHz) {
  const x = Math.exp(-2 * Math.PI * cutoffHz / SR)
  const a = 1 - x
  let y = 0
  for (let i = 0; i < samples.length; i++) {
    y = a * samples[i] + x * y
    samples[i] = y
  }
}

function render({ duration, notes, peak, cutoff = 2400, seed = 0xC0FFEE }) {
  rngState = seed
  const n = Math.floor(SR * duration)
  const L = new Float64Array(n)
  const R = new Float64Array(n)
  const haas = 9

  for (const note of notes) {
    for (let i = 0; i < n; i++) {
      const t = i / SR - note.start
      const s = mallet(t, note.freq, note) * (note.gain ?? 1)
      L[i] += s
      const j = i + haas
      if (j < n) R[j] += s
      else R[i] += s
    }
  }

  lowpass(L, cutoff)
  lowpass(R, cutoff)

  const fade = Math.floor(SR * 0.018)
  for (let i = 0; i < fade; i++) {
    const g = i / fade
    L[n - 1 - i] *= g
    R[n - 1 - i] *= g
  }

  let max = 0
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(L[i]), Math.abs(R[i]))
  const scale = max > 0 ? peak / max : 0
  for (let i = 0; i < n; i++) {
    L[i] *= scale
    R[i] *= scale
  }
  return { L, R }
}

function writeWav(filePath, { L, R }) {
  const n = L.length
  const dataSize = n * 4
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4)
  }
  fs.writeFileSync(filePath, buf)
}

fs.mkdirSync(outDir, { recursive: true })

const soft = { attack: 0.022, bodyTau: 0.22, brightTau: 0.055, air: 0.10 }

// 完成：中音区上行大三度，像轻轻敲了两下木琴
writeWav(path.join(outDir, 'cue-complete.wav'), render({
  duration: 0.58,
  peak: 0.16,
  cutoff: 2200,
  seed: 0xC0E001,
  notes: [
    { freq: 523.25, start: 0, gain: 1, ...soft },           // C5
    { freq: 659.25, start: 0.095, gain: 0.88, ...soft, bodyTau: 0.26 }, // E5
  ],
}))

// 失败：下行大三度，沉、不报警
writeWav(path.join(outDir, 'cue-failed.wav'), render({
  duration: 0.66,
  peak: 0.14,
  cutoff: 1900,
  seed: 0xFA11ED,
  notes: [
    { freq: 493.88, start: 0, gain: 1, ...soft, bodyTau: 0.20 },      // B4
    { freq: 392.00, start: 0.12, gain: 0.95, ...soft, bodyTau: 0.30 }, // G4
  ],
}))

// 批准：同一音两下轻叩，短、不尖
writeWav(path.join(outDir, 'cue-confirm.wav'), render({
  duration: 0.44,
  peak: 0.15,
  cutoff: 2100,
  seed: 0xC0F1A1,
  notes: [
    { freq: 440.0, start: 0, gain: 1, attack: 0.014, bodyTau: 0.09, brightTau: 0.04, air: 0.14 },
    { freq: 440.0, start: 0.155, gain: 0.82, attack: 0.014, bodyTau: 0.11, brightTau: 0.045, air: 0.12 },
  ],
}))

console.log(`wrote warmer cue sounds to ${outDir}`)
