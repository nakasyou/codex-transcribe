#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export interface TranscribeOptions {
  language?: string
  codexHome?: string
  baseUrl?: string
  timeoutMs?: number
  splitSeconds?: number
  onChunk?: (chunk: Transcription, index: number) => void | Promise<void>
}

export interface Transcription {
  text: string
  asset_pointer?: string
  asset_ttl?: string
  asset_format?: string
  chunks?: Transcription[]
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
  if (options.splitSeconds === undefined) return transcribeFile(audioPath, options)
  const seconds = options.splitSeconds
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('--split must be a positive number of seconds.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'codex-transcribe-'))
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
  }
  if (auth.tokens.account_id) headers['ChatGPT-Account-ID'] = auth.tokens.account_id
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
    })
  } catch {
    throw new Error('Transcription request failed or timed out.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    const hint = response.status === 401 ? ' Sign in again with codex login.' : ''
    throw new Error(`Transcription failed (HTTP ${response.status}).${hint}`)
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

const help = `Usage: codex-transcribe <audio-file> [options]

Options:
  --language <code>     Language hint (e.g. ja, en)
  --split <seconds>     Split audio into chunks and transcribe them in order (requires ffmpeg)
  --json                Print the full JSON response
  --codex-home <path>   Authentication directory (default: CODEX_HOME or ~/.codex)
  --base-url <url>      API base URL (default: CODEX_API_BASE_URL or https://chatgpt.com/backend-api)
  -h, --help            Show this help

Uses Codex ChatGPT authentication from auth.json. Does not refresh or modify credentials.`

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      language: { type: 'string' },
      split: { type: 'string' },
      json: { type: 'boolean' },
      'codex-home': { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }
  if (positionals.length !== 1) throw new Error(help)
  const result = await transcribe(positionals[0]!, {
    language: values.language,
    splitSeconds: values.split === undefined ? undefined : Number(values.split),
    codexHome: values['codex-home'],
    baseUrl: values['base-url'],
    onChunk:
      !values.json && values.split !== undefined
        ? (chunk) => {
            if (chunk.text.trim()) console.log(chunk.text.trim())
          }
        : undefined,
  })
  if (values.json) console.log(JSON.stringify(result, null, 2))
  else if (values.split === undefined) console.log(result.text)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Transcription failed.')
    process.exitCode = 1
  })
}
