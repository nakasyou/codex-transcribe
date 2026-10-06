import { afterEach, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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

function wav(seconds: number): Uint8Array {
  const rate = 16000
  const samples = Math.round(seconds * rate)
  const audio = new Uint8Array(44 + samples * 2)
  const view = new DataView(audio.buffer)
  const text = (offset: number, value: string) => audio.set(new TextEncoder().encode(value), offset)
  text(0, 'RIFF')
  view.setUint32(4, audio.length - 8, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.sin((i * 440 * 2 * Math.PI) / rate) * 4000, true)
  return audio
}

async function splitDirectories() {
  return (await readdir(tmpdir()))
    .filter(
      (name) => name.startsWith('codex-transcribe-') && !name.startsWith('codex-transcribe-test-'),
    )
    .sort()
}

test('splits real audio in order, includes the final short chunk, and cleans temporary files', async () => {
  const directory = await fixture({ tokens: { access_token: 'test-token' } })
  await writeFile(join(directory, 'voice.wav'), wav(2.5))
  const before = await splitDirectories()
  const names: string[] = []
  const sizes: number[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const form = await request.formData()
      const file = form.get('file') as File
      names.push(file.name)
      sizes.push(file.size)
      expect(form.get('language')).toBe('en')
      return Response.json({ text: `chunk ${names.length}`, asset_format: 'wav' })
    },
  })
  servers.push(server)
  const result = await transcribe(join(directory, 'voice.wav'), {
    codexHome: directory,
    baseUrl: String(server.url),
    splitSeconds: 1,
    language: 'en',
  })
  expect(names).toEqual(['chunk-000000000.wav', 'chunk-000000001.wav', 'chunk-000000002.wav'])
  expect(sizes[2]!).toBeLessThan(sizes[0]!)
  expect(result.text).toBe('chunk 1\nchunk 2\nchunk 3')
  expect(result.chunks).toHaveLength(3)
  expect(result.chunks?.[2]?.asset_format).toBe('wav')
  expect(await splitDirectories()).toEqual(before)
})

test('reports the failed chunk, stops uploading, and removes temporary audio', async () => {
  const directory = await fixture({ tokens: { access_token: 'test-token' } })
  await writeFile(join(directory, 'voice.wav'), wav(2.5))
  const before = await splitDirectories()
  let requests = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      requests++
      return requests === 1
        ? Response.json({ text: 'first' })
        : new Response('failure', { status: 500 })
    },
  })
  servers.push(server)
  await rejects(
    transcribe(join(directory, 'voice.wav'), {
      codexHome: directory,
      baseUrl: String(server.url),
      splitSeconds: 1,
    }),
    /Chunk 2\/3 failed: Transcription failed \(HTTP 500\)/,
  )
  expect(requests).toBe(2)
  expect(await splitDirectories()).toEqual(before)
  await rejects(transcribe(join(directory, 'missing.wav'), { splitSeconds: 1 }), /Unable to split/)
  expect(await splitDirectories()).toEqual(before)
})

test('rejects invalid split durations before processing audio', async () => {
  for (const seconds of [0, -1, NaN, Infinity]) {
    await rejects(transcribe('unused.wav', { splitSeconds: seconds }), /positive number of seconds/)
  }
})
