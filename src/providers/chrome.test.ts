import { afterEach, expect, spyOn, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeEvents, decodeRecognitionEvent, recognizeFlac } from './chrome'
import { main, parseProvider, transcribe } from '../index'

const directories: string[] = []
let restoreFetch: (() => void) | undefined
afterEach(async () => {
  restoreFetch?.()
  restoreFetch = undefined
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// Encoded using Chromium's published protobuf field numbers.
function event(text: string, final: boolean) {
  const transcript = Buffer.from(text)
  const alternative = Buffer.concat([Buffer.from([10, transcript.length]), transcript])
  const result = Buffer.concat([
    Buffer.from([10, alternative.length]),
    alternative,
    Buffer.from([16, final ? 1 : 0]),
  ])
  return Buffer.concat([Buffer.from([18, result.length]), result])
}
function frame(message: Uint8Array) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(message.length)
  return Buffer.concat([length, message])
}
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}
async function collect(body: ReadableStream<Uint8Array>) {
  const events = []
  for await (const value of decodeEvents(body)) events.push(value)
  return events
}
function fakeFlac() {
  const flac = Buffer.alloc(42)
  flac.write('fLaC')
  flac[7] = 34
  flac[18] = 3
  flac[19] = 232
  flac[20] = 0
  flac[21] = 240
  return flac
}

test('decodes fragmented frames, empty handshake, and multiple result events', async () => {
  expect(
    await collect(
      stream(
        Buffer.concat([
          frame(Buffer.alloc(0)),
          frame(event('途中', false)),
          frame(event('確定', true)),
        ]),
      ),
    ),
  ).toEqual([
    {},
    { result: [{ alternative: [{ transcript: '途中' }], final: false }] },
    { result: [{ alternative: [{ transcript: '確定' }], final: true }] },
  ])
  expect(decodeRecognitionEvent(Buffer.from([8, 6, 32, 3, 80, 1]))).toEqual({
    status: 6,
    endpoint: 3,
  })
})

test('rejects truncated and oversized frames and malformed protobuf', async () => {
  await rejects(collect(stream(Uint8Array.of(0, 0, 0, 2, 8))), /Truncated recognition frame/)
  await rejects(collect(stream(Uint8Array.of(1, 0, 0, 0))), /Oversized recognition frame/)
  expect(() => decodeRecognitionEvent(Uint8Array.of(18, 4, 8))).toThrow('truncated protobuf')
})

test('Chrome converts audio, uses paired requests without Codex auth, and accumulates final results only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ntranscribe-chrome-test-'))
  directories.push(directory)
  const input = join(directory, 'silence.wav')
  // Tiny valid mono 16 kHz WAV, converted by real ffmpeg.
  const wav = Buffer.alloc(44 + 3200)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(3200, 40)
  await writeFile(input, wav)
  const requests: URL[] = []
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const request = new URL(url instanceof Request ? url.url : url.toString())
    requests.push(request)
    expect(init?.headers).not.toHaveProperty('Authorization')
    expect(request.searchParams.get('key')).toStartWith('AIza')
    expect(request.searchParams.get('output')).toBe('pb')
    if (request.pathname.endsWith('/down')) {
      return new Response(
        stream(
          Buffer.concat([
            frame(event('wrong interim', false)),
            frame(event('hello', true)),
            frame(event('world', true)),
          ]),
        ),
      )
    }
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'audio/x-flac; rate=16000' })
    expect(
      Buffer.from(init!.body as Uint8Array)
        .subarray(0, 4)
        .toString(),
    ).toBe('fLaC')
    expect(request.searchParams.get('lang')).toBe('ja-JP')
    return new Response('')
  }) as typeof fetch)
  restoreFetch = () => mock.mockRestore()
  const before = (await readdir(tmpdir())).filter((name) => name.startsWith('ntranscribe-')).sort()
  const completed: string[] = []
  const result = await transcribe(input, {
    provider: 'chrome-recognizetion',
    codexHome: join(directory, 'nonexistent'),
    language: 'ja',
    onChunk: (chunk) => {
      completed.push(chunk.text)
    },
  })
  expect(requests.map((url) => url.pathname.split('/').at(-1))).toEqual(['down', 'up'])
  expect(requests[0]!.searchParams.get('pair')).toBe(requests[1]!.searchParams.get('pair'))
  expect(result.text).toBe('hello world')
  expect(result.chunks).toHaveLength(1)
  expect(completed).toEqual(['hello world'])
  expect(
    (await readdir(tmpdir())).filter((name) => name.startsWith('ntranscribe-')).sort(),
  ).toEqual(before)
  expect((await readFile(input)).length).toBe(wav.length)
})

test('preserves upstream HTTP failure when cancelling a waiting downstream', async () => {
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    if ((url instanceof Request ? url.url : url.toString()).includes('/up?'))
      return new Response('', { status: 500 })
    return new Response(
      new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
            once: true,
          })
        },
      }),
    )
  }) as typeof fetch)
  restoreFetch = () => mock.mockRestore()
  await rejects(async () => {
    for await (const _ of recognizeFlac(fakeFlac(), {})) {
      /* drain */
    }
  }, /Speech upstream HTTP 500/)
})

test('rejects provider and timeout mistakes before reading files', async () => {
  expect(parseProvider('chrome-recognition')).toBe('chrome-recognizetion')
  expect(() => parseProvider('invalid')).toThrow('Unknown provider')
  await rejects(main(['unused', '--provider', 'invalid']), /Unknown provider/)
  await rejects(main(['unused', '--timeout=-1']), /non-negative/)
  await rejects(transcribe('unused', { timeoutMs: NaN }), /timeoutMs/)
})
