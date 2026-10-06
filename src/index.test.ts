import { afterEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAuth, transcribe } from './index'

const directories: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true)
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(auth: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-transcribe-test-'))
  directories.push(directory)
  await writeFile(join(directory, 'auth.json'), JSON.stringify(auth))
  await writeFile(join(directory, 'voice.wav'), 'test audio')
  return directory
}

test('uploads audio and language with Codex authentication and preserves API metadata', async () => {
  const directory = await fixture({
    tokens: { access_token: 'test-token', account_id: 'test-account' },
  })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe('/backend-api/transcribe')
      expect(request.method).toBe('POST')
      expect(request.headers.get('authorization')).toBe('Bearer test-token')
      expect(request.headers.get('chatgpt-account-id')).toBe('test-account')
      const form = await request.formData()
      expect(form.get('language')).toBe('ja')
      const file = form.get('file') as File
      expect(['audio/wav', 'audio/x-wav']).toContain(file.type)
      expect(await file.text()).toBe('test audio')
      return Response.json({ text: 'こんにちは', asset_format: 'wav' })
    },
  })
  servers.push(server)
  expect(
    await transcribe(join(directory, 'voice.wav'), {
      codexHome: directory,
      baseUrl: `${server.url}backend-api`,
      language: 'ja',
    }),
  ).toEqual({ text: 'こんにちは', asset_format: 'wav' })
})

test('does not expose secrets from malformed authentication or API error bodies', async () => {
  const directory = await fixture({ tokens: { access_token: 'private-token' } })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return new Response('private-token', { status: 401 })
    },
  })
  servers.push(server)
  await rejects(
    transcribe(join(directory, 'voice.wav'), {
      codexHome: directory,
      baseUrl: String(server.url),
    }),
    /Transcription failed \(HTTP 401\).*Sign in again with codex login/,
  )
  await writeFile(join(directory, 'auth.json'), '{private-token')
  await rejects(readAuth(directory), /Cannot read Codex authentication/)
})

test('rejects API-key authentication and unexpected response schemas', async () => {
  const directory = await fixture({ OPENAI_API_KEY: 'test-key' })
  await rejects(readAuth(directory), /ChatGPT access token is missing/)
  await writeFile(
    join(directory, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'test-token' } }),
  )
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return Response.json({ result: 'wrong' })
    },
  })
  servers.push(server)
  await rejects(
    transcribe(join(directory, 'voice.wav'), {
      codexHome: directory,
      baseUrl: String(server.url),
    }),
    /invalid transcription response/,
  )
})
