# nTranscribe

Transcribe audio with Codex ChatGPT authentication or Chrome speech recognition.

```sh
nix run github:nakasyou/ntransctibe -- recording.mp3 --provider chrome-recognizetion --language ja
nix run github:nakasyou/ntransctibe -- recording.wav --provider codex --language ja
```

The command is `ntranscribe`; the GitHub repository is `nakasyou/ntransctibe`.
`chrome-recognition` is also accepted as an alias for `chrome-recognizetion`.

## Providers

| Provider               | Authentication                         | Audio processing                                                              | Request timeout    |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| `codex` (default)      | ChatGPT login from `codex login`       | Uploads the original file unless `--split` is supplied                        | 90 seconds         |
| `chrome-recognizetion` | Chrome API key embedded in the package | Converts to mono 16 kHz, 16-bit FLAC; splits into 10-minute chunks by default | No overall timeout |

Chrome does not read Codex credentials. It sends audio to Google's internal
`speech-api/full-duplex/v1` endpoint. A paired `/up` POST uploads FLAC and a
`/down` GET receives length-prefixed Protocol Buffers. It accumulates only final
recognition results. The embedded key was extracted from Google Chrome 155.
It can stop working if Google changes the key or service.

A 10-minute file upload completed successfully in about 100 seconds during local
experiments. Single 30-minute and 41-minute uploads failed after about three
minutes, so Chrome defaults to sequential 10-minute chunks. This is a tested
chunk size, not a documented service limit. Recognition results do not provide
word or segment timestamps. This CLI transcribes recorded files, not a live
microphone stream.

Codex uploads multipart audio to the internal ChatGPT `/transcribe` endpoint.
It reads `tokens.access_token` and optional `tokens.account_id` from
`~/.codex/auth.json` without modifying or refreshing them. Sign in again if the
credentials expire. It sends the desktop-compatible User-Agent and
`originator: Codex Desktop`. It does not use the public OpenAI Audio API.

## Run locally

```sh
ghq get nakasyou/ntransctibe
cd "$(ghq root)/github.com/nakasyou/ntransctibe"
bun install --frozen-lockfile
bun run start -- recording.mp3 --provider chrome-recognizetion --language ja
```

Install ffmpeg on PATH for Chrome and for `--split`. The Nix package includes it.
Nix flakes configure Linux and macOS on x86_64 and aarch64; x86_64 Linux is verified.
The bundled CLI also runs on Node with `node dist/index.mjs`.

## Options

| Option                 | Description                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | `codex` (default), `chrome-recognizetion`, or alias `chrome-recognition`                                            |
| `--language <code>`    | Language hint, e.g. `ja`, `en`, or `ja-JP`. Chrome maps `ja` to `ja-JP` and `en` to `en-US`; its default is `ja-JP` |
| `--split <seconds>`    | Positive chunk duration; Chrome defaults to 600, Codex defaults to no splitting                                     |
| `--timeout <seconds>`  | Overall request timeout per chunk; `0` disables it                                                                  |
| `--json`               | Print one JSON document containing text and provider response metadata                                              |
| `--codex-home <path>`  | Codex authentication directory; defaults to `CODEX_HOME` or `~/.codex`                                              |
| `--base-url <url>`     | Codex API base; defaults to `CODEX_API_BASE_URL` or `https://chatgpt.com/backend-api`                               |
| `--user-agent <value>` | Codex User-Agent; defaults to `NTRANSCRIBE_USER_AGENT` or a generated desktop identifier                            |
| `-h`, `--help`         | Show usage                                                                                                          |

`--codex-home`, `--base-url`, and `--user-agent` apply only to Codex. A custom
Codex base URL receives your token, so use a trusted endpoint. The generated
User-Agent includes `CODEX_APP_VERSION` when set; no desktop version is pinned.
HTTP error messages omit response bodies and credentials.

Text output prints each completed chunk immediately in recording order without
duplicating it at the end. `--json` waits for all chunks, returning
`{ text, chunks }`. Chrome chunk responses include `events`; Codex preserves its
API metadata. If a chunk fails, the error identifies the chunk and processing
stops. Previously printed text remains available. Temporary audio is removed on
success or failure. There is no overlap between chunks, so boundary words may
lose context. WAV splitting uses approximate audio packet boundaries.

```sh
# Shorter chunks, with a 3-minute request timeout per chunk.
ntranscribe recording.mp3 --provider chrome-recognition --split 300 --timeout 180

# Explicit splitting with Codex.
ntranscribe recording.m4a --provider codex --language ja --split 60
```

## Library

```ts
import { transcribe } from '@nakasyou/ntranscribe'

const result = await transcribe('recording.mp3', {
  provider: 'chrome-recognizetion',
  language: 'ja',
  splitSeconds: 600,
  timeoutMs: null,
  onChunk: (chunk) => console.log(chunk.text),
})
console.log(result.text)
```

`recognizeFlac()` is exported for receiving individual recognition events from a
mono, 16-bit FLAC buffer. It accepts `language`, `interim`, `timeoutMs`, and an
optional abort `signal`. It does not split or convert audio. Omitted/null timeout
disables the overall timeout for this low-level Chrome API. An omitted timeout
in `transcribe()` uses the provider's default; `null` disables it explicitly.

## Development

```sh
bun install --frozen-lockfile
bun run fmt
bun run check
bun test
bun run build
npm pack --dry-run
nix build
nix run . -- --help
```

Vite+ handles formatting, lint, type checking, and package bundling. Runtime code
has no npm dependencies, so the Nix build bundles directly with Bun offline.

The manually dispatched `publish.yml` workflow bumps an existing npm release and
uses npm trusted publishing. Configure the trusted publisher for the package
`@nakasyou/ntranscribe`, owner `nakasyou`, repository `ntransctibe`, workflow
`publish.yml`, allowing `npm publish`. The renamed package requires an initial
npm publication before this bump workflow can run. Renaming the GitHub repository
does not migrate an existing npm package or its trusted publisher.

Protocol references:

- [Chromium network recognition engine](https://github.com/chromium/chromium/blob/main/content/browser/speech/network_speech_recognition_engine_impl.cc)
- [Chromium recognition protobuf schema](https://github.com/chromium/chromium/blob/main/content/public/browser/google_streaming_api.proto)

### Adding a provider

```text
src/
  index.ts              CLI and public exports
  transcribe.ts         Splitting, ordering, callbacks, and temporary-file cleanup
  types.ts              Shared provider contract and result types
  providers/
    index.ts            Provider registry, aliases, and name validation
    codex.ts            Codex authentication and requests
    chrome.ts           FLAC conversion, Chrome transport, and protobuf decoding
```

Implement `TranscriptionProvider` in `src/providers/<name>.ts` and add its object
to the `providers` array in `src/providers/index.ts`. The registry determines the
CLI's accepted provider names, aliases, and the TypeScript `Provider` union.
The shared transcription flow uses each provider's `defaultSplitSeconds` and
`transcribeFile()` method, so adding a provider does not require another branch
in the CLI or splitting code.

Every provider returns `{ text }` and may include its own response metadata.
Shared request options are `language` and `timeoutMs`; provider-specific options
and response types live alongside the corresponding implementation.
