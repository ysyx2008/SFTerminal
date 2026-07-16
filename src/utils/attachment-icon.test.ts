import { describe, expect, it } from 'vitest'
import { getAttachmentIconMeta, resolveAttachmentExt } from './attachment-icon'

describe('resolveAttachmentExt', () => {
  it('prefers fileType over filename', () => {
    expect(resolveAttachmentExt('pdf', 'a.docx')).toBe('pdf')
  })

  it('falls back to filename extension', () => {
    expect(resolveAttachmentExt(undefined, 'report.xlsx')).toBe('xlsx')
    expect(resolveAttachmentExt('unknown', 'notes.md')).toBe('md')
  })

  it('handles mime-like fileType', () => {
    expect(resolveAttachmentExt('application/pdf', 'x.bin')).toBe('pdf')
  })
})

describe('getAttachmentIconMeta', () => {
  it('maps common office types', () => {
    expect(getAttachmentIconMeta('pdf')).toMatchObject({ kind: 'pdf', color: '#ef5350' })
    expect(getAttachmentIconMeta('docx')).toMatchObject({ kind: 'word' })
    expect(getAttachmentIconMeta('xlsx')).toMatchObject({ kind: 'sheet' })
    expect(getAttachmentIconMeta('pptx')).toMatchObject({ kind: 'slides' })
  })

  it('maps media and archives', () => {
    expect(getAttachmentIconMeta(undefined, 'photo.png').kind).toBe('image')
    expect(getAttachmentIconMeta(undefined, 'song.mp3').kind).toBe('audio')
    expect(getAttachmentIconMeta(undefined, 'clip.mp4').kind).toBe('video')
    expect(getAttachmentIconMeta(undefined, 'bundle.zip').kind).toBe('archive')
  })

  it('defaults to generic file', () => {
    expect(getAttachmentIconMeta(undefined, 'weird.xyz').kind).toBe('file')
    expect(getAttachmentIconMeta().kind).toBe('file')
  })
})
