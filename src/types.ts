/** Options passed to a provider for one file or chunk. */
export interface ProviderOptions {
  language?: string
  timeoutMs?: number | null
}

/** Every provider returns text and may preserve its own response metadata. */
export interface Transcription {
  text: string
  chunks?: Transcription[]
  [metadata: string]: unknown
}

export interface TranscriptionProvider {
  readonly id: string
  readonly aliases?: readonly string[]
  /** Undefined means the original file is uploaded without splitting. */
  readonly defaultSplitSeconds?: number
  transcribeFile(audioPath: string, options: ProviderOptions): Promise<Transcription>
}
