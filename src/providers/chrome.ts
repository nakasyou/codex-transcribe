import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderOptions, Transcription, TranscriptionProvider } from '../types'
import { randomBytes } from 'node:crypto'

// Extracted from the installed Google Chrome 155 binary (GOOGLE_API_KEY).
const CHROME_API_KEY = 'AIzaSyBqJZh-7pA44blAaAkH6490hUFOwX0KCYM'

// Field numbers follow Chromium's content/public/browser/google_streaming_api.proto.
// Decode only the schema we consume; unknown protobuf fields are skipped.
interface Field {
  number: number
  wire: number
  value: number | Uint8Array
}
function* fields(bytes: Uint8Array): Generator<Field> {
  let offset = 0
  const varint = () => {
    let value = 0
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf varint')
      const byte = bytes[offset++]!
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
    }
    throw new Error('Invalid protobuf varint')
  }
  while (offset < bytes.length) {
    const tag = varint()
    const wire = tag % 8
    const number = Math.floor(tag / 8)
    if (!number) throw new Error('Invalid protobuf field')
    if (wire === 0) {
      yield { number, wire, value: varint() }
      continue
    }
    const length = wire === 2 ? varint() : wire === 5 ? 4 : wire === 1 ? 8 : -1
    if (length < 0 || !Number.isSafeInteger(length) || length > bytes.length - offset) {
      throw new Error('Invalid or truncated protobuf field')
    }
    const value = bytes.subarray(offset, offset + length)
    offset += length
    yield { number, wire, value }
  }
}
function float(value: Uint8Array): number {
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat32(0, true)
}
export function decodeRecognitionEvent(bytes: Uint8Array): RecognitionEvent {
  const event: RecognitionEvent = {}
  for (const field of fields(bytes)) {
    if (field.wire === 0 && typeof field.value === 'number') {
      if (field.number === 1) event.status = field.value
      if (field.number === 4) event.endpoint = field.value
    }
    if (field.number !== 2 || field.wire !== 2 || typeof field.value === 'number') continue
    const result: NonNullable<RecognitionEvent['result']>[number] = {}
    for (const item of fields(field.value)) {
      if (item.number === 2 && item.wire === 0) result.final = Boolean(item.value)
      if (item.number === 3 && item.wire === 5 && typeof item.value !== 'number')
        result.stability = float(item.value)
      if (item.number !== 1 || item.wire !== 2 || typeof item.value === 'number') continue
      const alternative: { transcript?: string; confidence?: number } = {}
      for (const value of fields(item.value)) {
        if (typeof value.value === 'number') continue
        if (value.number === 1 && value.wire === 2)
          alternative.transcript = new TextDecoder().decode(value.value)
        if (value.number === 2 && value.wire === 5) alternative.confidence = float(value.value)
      }
      ;(result.alternative ??= []).push(alternative)
    }
    ;(event.result ??= []).push(result)
  }
  return event
}

function normalizeLanguage(language?: string): string {
  const defaults: Record<string, string> = { ja: 'ja-JP', en: 'en-US', ko: 'ko-KR', zh: 'zh-CN' }
  return language ? (defaults[language] ?? language) : 'ja-JP'
}

export interface RecognitionEvent {
  status?: number
  result?: Array<{
    alternative?: Array<{ transcript?: string; confidence?: number }>
    final?: boolean
    stability?: number
  }>
  endpoint?: number
}

/** HTTP chunks and protobuf frames have independent boundaries. */
export async function* decodeEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RecognitionEvent> {
  const reader = body.getReader()
  let pending = Buffer.alloc(0)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending = Buffer.concat([pending, value])
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0)
        if (length > 8 * 1024 * 1024) throw new Error('Oversized recognition frame')
        if (pending.length < length + 4) break
        const message = decodeRecognitionEvent(pending.subarray(4, 4 + length))
        pending = pending.subarray(4 + length)
        yield message
      }
    }
    if (pending.length) throw new Error('Truncated recognition frame')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export interface RecognizeOptions {
  language?: string
  interim?: boolean
  /** Omitted or null disables the overall request timeout. */
  timeoutMs?: number | null
  signal?: AbortSignal
}

/** Input: mono, 16-bit FLAC. Sample rate is read from STREAMINFO. */
export async function* recognizeFlac(
  audio: Uint8Array,
  options: RecognizeOptions = {},
): AsyncGenerator<RecognitionEvent> {
  if (
    audio.length < 42 ||
    Buffer.from(audio.subarray(0, 4)).toString() !== 'fLaC' ||
    (audio[4] & 0x7f) !== 0 ||
    ((audio[5] << 16) | (audio[6] << 8) | audio[7]) !== 34
  ) {
    throw new Error('Expected a FLAC file with STREAMINFO')
  }
  const sampleRate = (audio[18] << 12) | (audio[19] << 4) | (audio[20] >> 4)
  const channels = ((audio[20] >> 1) & 7) + 1
  const bits = (((audio[20] & 1) << 4) | (audio[21] >> 4)) + 1
  if (!sampleRate || channels !== 1 || bits !== 16) throw new Error('Expected mono, 16-bit FLAC')

  const controller = new AbortController()
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.timeoutMs == null ? [] : [AbortSignal.timeout(options.timeoutMs)]),
    ...(options.signal ? [options.signal] : []),
  ])
  const base = 'https://www.google.com/speech-api/full-duplex/v1'
  const common = {
    key: CHROME_API_KEY,
    pair: randomBytes(8).toString('hex').toUpperCase(),
    output: 'pb',
  }
  const down = new URLSearchParams(common)
  const up = new URLSearchParams({
    ...common,
    lang: normalizeLanguage(options.language),
    app: 'chromium',
    pFilter: '0',
    maxAlternatives: '1',
  })
  up.append('continuous', '')
  if (options.interim) up.append('interim', '')

  // Start the downstream request first; don't await its headers before uploading.
  const downstream = fetch(`${base}/down?${down}`, { signal })
  const upstream = fetch(`${base}/up?${up}`, {
    method: 'POST',
    headers: { 'Content-Type': `audio/x-flac; rate=${sampleRate}` },
    body: Buffer.from(audio),
    signal,
  }).then(async (response) => {
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Speech upstream HTTP ${response.status}`)
  })
  // Abort the other request immediately if either fails, and handle rejections.
  void downstream.catch((error) => controller.abort(error))
  void upstream.catch((error) => controller.abort(error))
  try {
    const response = await downstream
    if (!response.ok) throw new Error(`Speech downstream HTTP ${response.status}`)
    if (!response.body) throw new Error('Missing recognition response body')
    for await (const event of decodeEvents(response.body)) {
      if (event.status) throw new Error(`Speech recognition status ${event.status}`)
      yield event
    }
    await upstream
  } finally {
    controller.abort()
    await Promise.allSettled([downstream, upstream])
  }
}

export interface ChromeTranscription extends Transcription {
  events: RecognitionEvent[]
}

async function transcribeChromeFile(
  audioPath: string,
  options: ProviderOptions,
): Promise<ChromeTranscription> {
  const directory = await mkdtemp(join(tmpdir(), 'ntranscribe-chrome-'))
  try {
    const output = join(directory, 'audio.flac')
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
        '-sample_fmt',
        's16',
        output,
      ])
    } catch (error) {
      throw new Error(
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'ffmpeg is required for Chrome recognition. Install ffmpeg or use the Nix package.'
          : 'Unable to convert audio to FLAC with ffmpeg.',
      )
    }
    const events: RecognitionEvent[] = []
    const segments: string[] = []
    for await (const event of recognizeFlac(await readFile(output), {
      language: options.language,
      timeoutMs: options.timeoutMs,
    })) {
      events.push(event)
      for (const result of event.result ?? []) {
        if (result.final) segments.push(result.alternative?.[0]?.transcript ?? '')
      }
    }
    return {
      text: segments
        .map((text) => text.trim())
        .filter(Boolean)
        .join(' '),
      events,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const chromeProvider = {
  id: 'chrome-recognizetion',
  aliases: ['chrome-recognition'],
  defaultSplitSeconds: 600,
  transcribeFile: transcribeChromeFile,
} as const satisfies TranscriptionProvider
