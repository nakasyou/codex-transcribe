import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getProvider, type Provider, type RegisteredProviderOptions } from './providers'
import type { Transcription } from './types'

export type TranscribeOptions = RegisteredProviderOptions & {
  provider?: Provider
  splitSeconds?: number
  onChunk?: (chunk: Transcription, index: number) => void | Promise<void>
}

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<Transcription> {
  const provider = getProvider(options.provider)
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('timeoutMs must be a positive number or null.')
  }
  const seconds = options.splitSeconds ?? provider.defaultSplitSeconds
  if (seconds === undefined) return provider.transcribeFile(audioPath, options)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--split must be a positive number of seconds.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'ntranscribe-'))
  try {
    try {
      await promisify(execFile)('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-i',
        resolve(audioPath),
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'segment',
        '-segment_time',
        String(seconds),
        '-reset_timestamps',
        '1',
        join(directory, 'chunk-%09d.wav'),
      ])
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      throw new Error(
        missing
          ? 'ffmpeg is required for --split. Install ffmpeg or use the Nix package.'
          : 'Unable to split the audio file with ffmpeg. Check that it contains readable audio.',
      )
    }
    const files = (await readdir(directory)).filter((file) => /^chunk-\d+\.wav$/.test(file)).sort()
    if (!files.length) throw new Error('No audio chunks were produced.')
    const chunks: Transcription[] = []
    for (const [index, file] of files.entries()) {
      try {
        const chunk = await provider.transcribeFile(join(directory, file), options)
        chunks.push(chunk)
        await options.onChunk?.(chunk, index)
      } catch (error) {
        throw new Error(
          `Chunk ${index + 1}/${files.length} failed: ${error instanceof Error ? error.message : 'Transcription failed.'}`,
        )
      }
    }
    return {
      text: chunks
        .map((chunk) => chunk.text.trim())
        .filter(Boolean)
        .join('\n'),
      chunks,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
