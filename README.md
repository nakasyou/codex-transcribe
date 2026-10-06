# codex-transcribe

Transcribe an audio file using the ChatGPT authentication stored by Codex in `~/.codex/auth.json`.

## Run with Nix

```sh
nix run github:nakasyou/codex-transcribe -- recording.wav --language ja
nix run github:nakasyou/codex-transcribe -- recording.wav --json
```

Requires Nix with flakes enabled and a ChatGPT login from `codex login`. Linux and macOS on x86_64 and aarch64 are configured; x86_64 Linux is verified.

## Run with Bun

```sh
ghq get nakasyou/codex-transcribe
cd "$(ghq root)/github.com/nakasyou/codex-transcribe"
bun install --frozen-lockfile
bun run start -- recording.wav --language ja
```

The CLI prints transcription text by default. `--json` prints the complete API response, including any asset metadata.

| Option                | Description                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `--language <code>`   | Optional language hint, such as `ja` or `en`                                    |
| `--json`              | Print the complete JSON response                                                |
| `--codex-home <path>` | Directory containing `auth.json`; defaults to `CODEX_HOME` or `~/.codex`        |
| `--base-url <url>`    | API base; defaults to `CODEX_API_BASE_URL` or `https://chatgpt.com/backend-api` |
| `-h`, `--help`        | Show usage                                                                      |

Audio is uploaded as multipart `file` with an optional `language` field to `/transcribe`. Authentication uses `tokens.access_token` and, if present, `tokens.account_id`. Credentials are read only when invoked and never copied into the build. This tool does not refresh tokens; run `codex login` again if authentication expires.

The endpoint is the internal ChatGPT backend used by Codex Desktop, rather than the public OpenAI Audio API. It may change. This CLI implements recorded-file transcription; it does not implement live WebSocket transcription. Audio is sent to the configured backend. A custom `--base-url` receives your authentication token, so use a trusted endpoint.

## Development

```sh
bun install --frozen-lockfile
bun run fmt
bun run lint
bun run check
bun test
bun run build
nix build
nix run . -- --help
```

Vite+ handles lint, formatting, type checking, and package bundling. Formatting uses `singleQuote: true` and `semi: false`. The runtime has no external dependencies. The Nix build bundles the TypeScript source with Bun without downloading npm dependencies.

The manually dispatched `publish.yml` workflow bumps an existing npm release and publishes with npm trusted publishing. Before using it, configure npm's trusted publisher for owner `nakasyou`, repository `codex-transcribe`, workflow `publish.yml`, allowing `npm publish`. An initial npm publication must exist before the bump workflow can run.
