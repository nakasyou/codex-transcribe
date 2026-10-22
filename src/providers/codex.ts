import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ProviderOptions, Transcription, TranscriptionProvider } from '../types'

export interface CodexOptions extends ProviderOptions {
  userAgent?: string
  codexHome?: string
  baseUrl?: string
}

export interface CodexTranscription extends Transcription {
  asset_pointer?: string
  asset_ttl?: string
  asset_format?: string
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

async function transcribeCodexFile(
  audioPath: string,
  options: CodexOptions,
): Promise<CodexTranscription> {
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
  return result as CodexTranscription
}

export const codexProvider = {
  id: 'codex',
  transcribeFile: transcribeCodexFile,
} as const satisfies TranscriptionProvider
