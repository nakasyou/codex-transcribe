#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { recognizeFlac, type RecognitionEvent } from './chrome'

export { recognizeFlac, type RecognitionEvent } from './chrome'
export type Provider = 'codex' | 'chrome-recognizetion'

export function parseProvider(value: string = 'codex'): Provider {
  if (value === 'chrome-recognition') return 'chrome-recognizetion'
  if (value === 'codex' || value === 'chrome-recognizetion') return value
  throw new Error('Unknown provider. Choose codex or chrome-recognizetion.')
}

export interface TranscribeOptions {
  provider?: Provider
  language?: string
  userAgent?: string
  codexHome?: string
  baseUrl?: string
  timeoutMs?: number | null
  splitSeconds?: number
  onChunk?: (chunk: Transcription, index: number) => void | Promise<void>
}

export interface Transcription {
  text: string
  asset_pointer?: string
  asset_ttl?: string
  asset_format?: string
  chunks?: Transcription[]
  events?: RecognitionEvent[]
}

// Mirrors the desktop bootstrap's OS labels and User-Agent shape. Omit
// the version when unknown instead of pinning a stale desktop release.
export function desktopUserAgent(
  platform: string = process.platform,
  arch: string = process.arch,
  version: string | undefined = process.env.CODEX_APP_VERSION,
): string {
  const platforms: Record<string, string> = {
    darwin: 'Mac OS',
    linux: 'X11; Linux',
    win32: 'Windows NT 10.0',
  }
  const release = version?.trim()
  return `Codex Desktop${release ? `/${release}` : ''} (${platforms[platform] ?? platform}; ${arch})`
}

export class TranscriptionHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly browserChallenge: boolean,
    public readonly retryAfter: string | null,
  ) {
    const hint = browserChallenge
      ? ' The server requested a browser challenge; check the desktop User-Agent and network route.'
      : status === 401
        ? ' Sign in again with codex login.'
        : ''
    super(`Transcription failed (HTTP ${status}).${hint}`)
    this.name = 'TranscriptionHttpError'
  }
}

interface Auth {
  tokens: { access_token: string; account_id?: string }
}

export async function readAuth(codexHome: string): Promise<Auth> {
  const path = join(codexHome, 'auth.json')
  let auth: unknown
  try {
    auth = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`Cannot read Codex authentication at ${path}. Sign in with codex login.`)
  }
  if (
    typeof auth !== 'object' ||
    auth === null ||
    !('tokens' in auth) ||
    typeof auth.tokens !== 'object' ||
    auth.tokens === null ||
    !('access_token' in auth.tokens) ||
    typeof auth.tokens.access_token !== 'string' ||
    !auth.tokens.access_token.trim()
  ) {
    throw new Error('ChatGPT access token is missing. Sign in with codex login.')
  }
  const accountId = 'account_id' in auth.tokens ? auth.tokens.account_id : undefined
  return {
    tokens: {
      access_token: auth.tokens.access_token,
      account_id: typeof accountId === 'string' ? accountId : undefined,
    },
  }
}

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<Transcription> {
  const provider = parseProvider(options.provider)
  options = { ...options, provider }
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('timeoutMs must be a positive number or null.')
  }
  const seconds = options.splitSeconds ?? (provider === 'chrome-recognizetion' ? 600 : undefined)
  if (seconds === undefined) return transcribeFile(audioPath, options)
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
        const chunk = await transcribeFile(join(directory, file), options)
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

async function transcribeFile(
  audioPath: string,
  options: TranscribeOptions,
): Promise<Transcription> {
  if (options.provider === 'chrome-recognizetion') return transcribeChromeFile(audioPath, options)
  const baseUrl =
    options.baseUrl ?? process.env.CODEX_API_BASE_URL ?? 'https://chatgpt.com/backend-api'
  const endpoint = new URL(`${baseUrl.replace(/\/+$/, '')}/transcribe`)
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
  ) {
    throw new Error('The API URL must use HTTPS (HTTP is allowed for localhost).')
  }
  const auth = await readAuth(
    options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  )
  let audio: Buffer
  try {
    audio = await readFile(audioPath)
  } catch {
    throw new Error(`Cannot read audio file: ${audioPath}`)
  }
  if (!audio.length) throw new Error('The audio file is empty.')
  const extension = audioPath.split('.').at(-1)?.toLowerCase() ?? ''
  const contentType =
    (
      {
        wav: 'audio/wav',
        webm: 'audio/webm',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        mp4: 'audio/mp4',
        ogg: 'audio/ogg',
        flac: 'audio/flac',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), basename(audioPath))
  if (options.language) form.append('language', options.language)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    originator: 'Codex Desktop',
    'User-Agent': options.userAgent ?? process.env.NTRANSCRIBE_USER_AGENT ?? desktopUserAgent(),
  }
  if (auth.tokens.account_id) headers['ChatGPT-Account-ID'] = auth.tokens.account_id
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
      redirect: 'error',
      signal:
        options.timeoutMs === null ? undefined : AbortSignal.timeout(options.timeoutMs ?? 90_000),
    })
  } catch {
    throw new Error('Transcription request failed or timed out.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new TranscriptionHttpError(
      response.status,
      response.headers.get('cf-mitigated') === 'challenge',
      response.headers.get('retry-after'),
    )
  }
  const result: unknown = await response.json()
  if (
    typeof result !== 'object' ||
    result === null ||
    !('text' in result) ||
    typeof result.text !== 'string'
  ) {
    throw new Error('The API returned an invalid transcription response.')
  }
  return result as Transcription
}

async function transcribeChromeFile(
  audioPath: string,
  options: TranscribeOptions,
): Promise<Transcription> {
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

const help = `Usage: ntranscribe <audio-file> [options]

Options:
  --provider <name>    codex (default) or chrome-recognizetion
  --timeout <seconds>  Overall request timeout per chunk; 0 disables (Codex: 90, Chrome: disabled)
  --language <code>     Language hint (e.g. ja, en)
  --split <seconds>     Chunk duration (Chrome default: 600; requires ffmpeg)
  --user-agent <value>  Override the desktop-compatible User-Agent
  --json                Print the full JSON response
  --codex-home <path>   Authentication directory (default: CODEX_HOME or ~/.codex)
  --base-url <url>      API base URL (default: CODEX_API_BASE_URL or https://chatgpt.com/backend-api)
  -h, --help            Show this help

Codex uses auth.json. Chrome uses its bundled API key and requires ffmpeg.
Chrome converts audio to FLAC and splits into 10-minute chunks by default.`

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      timeout: { type: 'string' },
      language: { type: 'string' },
      split: { type: 'string' },
      json: { type: 'boolean' },
      'codex-home': { type: 'string' },
      'base-url': { type: 'string' },
      'user-agent': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }
  if (positionals.length !== 1) throw new Error(help)
  const provider = parseProvider(values.provider)
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout)
  if (
    timeout !== undefined &&
    (!values.timeout?.trim() || !Number.isFinite(timeout) || timeout < 0)
  ) {
    throw new Error('--timeout must be a non-negative number of seconds (0 disables).')
  }
  const result = await transcribe(positionals[0]!, {
    provider,
    timeoutMs: timeout === 0 ? null : timeout === undefined ? undefined : timeout * 1000,
    language: values.language,
    splitSeconds: values.split === undefined ? undefined : Number(values.split),
    codexHome: values['codex-home'],
    baseUrl: values['base-url'],
    userAgent: values['user-agent'],
    onChunk: !values.json
      ? (chunk) => {
          if (chunk.text.trim()) console.log(chunk.text.trim())
        }
      : undefined,
  })
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else if (!result.chunks) console.log(result.text)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Transcription failed.')
    process.exitCode = 1
  })
}
