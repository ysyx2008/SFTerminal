export type DocumentParseStatus = 'queued' | 'parsing' | 'completed' | 'failed'

export type DocumentParsePhase =
  | 'queued'
  | 'loading'
  | 'extracting-text'
  | 'detecting-images'
  | 'rendering-preview'
  | 'converting'
  | 'formatting'
  | 'completed'
  | 'failed'

export interface DocumentParseProgress {
  requestId: string
  fileIndex: number
  fileCount: number
  filename: string
  fileSize: number
  status: DocumentParseStatus
  phase: DocumentParsePhase
  percent: number
  current?: number
  total?: number
  message?: string
  error?: string
}
