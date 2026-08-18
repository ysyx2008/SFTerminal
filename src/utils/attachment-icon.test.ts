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
    expect(resolveAttachmentExt('application/wps-office.wps', 'x.bin')).toBe('docx')
    expect(resolveAttachmentExt('application/kswps', 'x.bin')).toBe('docx')
    expect(resolveAttachmentExt('application/wps-office.et', 'x.bin')).toBe('xlsx')
    expect(resolveAttachmentExt('application/kset', 'x.bin')).toBe('xlsx')
  })
})

describe('getAttachmentIconMeta', () => {
  it('maps common office types', () => {
    expect(getAttachmentIconMeta('pdf')).toMatchObject({ kind: 'pdf', color: '#ef5350' })
    expect(getAttachmentIconMeta('docx')).toMatchObject({ kind: 'word' })
    expect(getAttachmentIconMeta('xlsx')).toMatchObject({ kind: 'sheet' })
    expect(getAttachmentIconMeta('pptx')).toMatchObject({ kind: 'slides' })
    expect(getAttachmentIconMeta('wps')).toMatchObject({ kind: 'word' })
    expect(getAttachmentIconMeta('wpt', '模板.wpt')).toMatchObject({ kind: 'word' })
    expect(getAttachmentIconMeta('et')).toMatchObject({ kind: 'sheet' })
    expect(getAttachmentIconMeta(undefined, '工资.ett')).toMatchObject({ kind: 'sheet' })
    expect(getAttachmentIconMeta('application/wps-office.wps').kind).toBe('word')
    expect(getAttachmentIconMeta('application/wps-office.et').kind).toBe('sheet')
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
