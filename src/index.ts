#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseProvider, providers } from './providers'
import { transcribe } from './transcribe'

export { parseProvider, providers, getProvider, type Provider } from './providers'
export { transcribe, type TranscribeOptions } from './transcribe'
export type { ProviderOptions, Transcription, TranscriptionProvider } from './types'
export {
  desktopUserAgent,
  readAuth,
  TranscriptionHttpError,
  type CodexOptions,
  type CodexTranscription,
} from './providers/codex'
export { recognizeFlac, type RecognitionEvent, type ChromeTranscription } from './providers/chrome'

const help = `Usage: ntranscribe <audio-file> [options]

Options:
  --provider <name>    ${providers.map((provider) => provider.id).join(' | ')} (default: codex)
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
