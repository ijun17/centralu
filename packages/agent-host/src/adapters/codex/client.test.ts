import { describe, expect, it } from 'vitest'
import { CodexClient } from './client.js'

/**
 * **A shutdown we caused is not the same as the other side dying.**
 *
 * Without this distinction, an entire day of investigation was lost. When resuming a locked
 * conversation failed, the manager cleaned the session up (dispose), and that **ordinary
 * shutdown** came back through the adapter as `adapter_crashed`, printing "codex app-server
 * exited" on screen. The real reason ("already has an active writer") was buried underneath, out
 * of sight, and the person was told that a process which had never died had died.
 *
 * This is confirmed by launching a real process — this contract is the process lifecycle itself,
 * and mocking it would miss exactly the spot where it actually goes wrong.
 */
const exitOf = (args: string[]) =>
  new Promise<{ code: number | null; expected: boolean }>((resolve) => {
    const client = new CodexClient(
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onExit: (code, expected) => resolve({ code, expected }),
      },
      { command: process.execPath, args },
    )
    // We can only close a process that is still alive — the case of one that dies right after starting is covered by the test below
    if (args[1]?.includes('setTimeout')) setTimeout(() => void client.dispose(), 150)
  })

describe('codex app-server exit judgment', () => {
  it('expected=true when we close it — does not report it as having died', async () => {
    const { expected } = await exitOf(['-e', 'setTimeout(() => {}, 60000)'])
    expect(expected).toBe(true)
  })

  it('expected=false when the other side ends on its own — only then is it a crash', async () => {
    const { expected, code } = await exitOf(['-e', 'process.exit(3)'])
    expect(expected).toBe(false)
    expect(code).toBe(3)
  })

  /*
   * A spawn failure (ENOENT — when the path is off because of an nvm switch or codex being
   * removed) arrives as 'error', not 'exit'. With no listener, it bubbles up as an
   * uncaughtException, killing the entire host and disconnecting every live Claude session too,
   * just because one codex was missing. Only this session must fail: the waiting request is
   * rejected with a reason, and onExit fires exactly once.
   */
  it('a nonexistent command fails only this session, without killing the process', async () => {
    let exits = 0
    const client = new CodexClient(
      {
        onNotification: () => {},
        onServerRequest: () => {},
        onExit: () => {
          exits++
        },
      },
      { command: '/nonexistent/cc-no-such-codex' },
    )

    // A short timeout: the rejection comes from spawn's 'error', but this keeps a leftover timer from holding the test runner open
    await expect(client.request('initialize', {}, 1000)).rejects.toThrow(/failed to start/)
    // onExit fires only once even if both 'error' and 'exit' arrive (the finished flag)
    await new Promise((r) => setTimeout(r, 100))
    expect(exits).toBe(1)
    // Requesting again on a client that has already ended is rejected immediately, not left hanging silently
    await expect(client.request('x')).rejects.toThrow(/already exited/)
  })
})

/**
 * A very long line does not get chopped up (the actual culprit behind the MGH resume incident).
 *
 * `readline.createInterface` silently split a 23,244,422-byte `thread/resume` response into
 * 22,049,101 bytes plus the remainder — neither piece was valid JSON anymore, the response was
 * dropped as "non-JSON output", and that request's promise never resolved. Capturing the raw
 * stream showed codex sent the line whole — we were the ones who cut it.
 *
 * This is checked at real size (24MB). readline also passes at a smaller size — this bug's
 * **condition is the size itself**, so shrinking it would leave the test guarding nothing.
 */
describe('CodexClient stream truncation', () => {
  it('a 24MB single-line response arrives intact', async () => {
    // A stand-in for app-server: on receiving one request line, it writes one huge response line (no real codex needed)
    const fake = [
      `process.stdin.once('data', () => {`,
      `  const big = JSON.stringify({ id: '1', result: { blob: 'x'.repeat(24 * 1024 * 1024) } })`,
      `  process.stdout.write(big + '\\n', () => setTimeout(() => process.exit(0), 200))`,
      `})`,
    ].join('\n')

    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { command: process.execPath, args: ['-e', fake] },
    )
    try {
      const res = await client.request<{ blob: string }>('probe', {}, 20_000)
      expect(res.blob.length).toBe(24 * 1024 * 1024)
    } finally {
      await client.dispose()
    }
  }, 30_000)
})

/**
 * A broken frame is not dropped silently (this is itself the safeguard against a repeat of the
 * readline incident).
 *
 * Why this layer stays even after the truncation fix: we do not know where the next truncation
 * will come from — a parser regression, codex writing over the buffer, a new runtime. Wherever it
 * comes from, it must **fail with a reason instead of hanging**, so a retry has a point and a
 * person is left with a readable cause.
 */
describe('a broken frame', () => {
  it('a non-JSON line starting with { wakes the waiting request with a reason', async () => {
    // A stand-in that **deliberately** produces a broken frame (truncated JSON) on receiving a request
    const fake = [
      `process.stdin.once('data', () => {`,
      `  process.stdout.write('{"id":"1","result":{"never":"closes"' + '\\n')`,
      `  setTimeout(() => {}, 60000)`,
      `})`,
    ].join('\n')
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { command: process.execPath, args: ['-e', fake] },
    )
    try {
      await expect(client.request('probe', {}, 10_000)).rejects.toThrow(/could not parse/)
    } finally {
      await client.dispose()
    }
  })

  it('stray text not starting with { does not fail the session — a banner is just a banner', async () => {
    const fake = [
      `process.stdin.once('data', () => {`,
      `  process.stdout.write('codex banner: hello\\n')`,
      `  process.stdout.write(JSON.stringify({ id: '1', result: { ok: true } }) + '\\n', () => setTimeout(() => process.exit(0), 200))`,
      `})`,
    ].join('\n')
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { command: process.execPath, args: ['-e', fake] },
    )
    try {
      const res = await client.request<{ ok: boolean }>('probe', {}, 10_000)
      expect(res.ok).toBe(true)
    } finally {
      await client.dispose()
    }
  })

  /**
   * A property check for framing: the frame must come out the same **no matter how the stream is
   * chopped up on arrival**. The readline incident was a violation of exactly this property —
   * checking the property, rather than one instance, is what catches the next violation too.
   * This covers arriving one character at a time (the worst-case boundary), including a
   * multi-byte Korean character landing right on a chunk boundary.
   */
  it('the frame stays intact even streamed one character at a time, and even with Korean text split across a boundary', async () => {
    const fake = [
      `const msg = Buffer.from(JSON.stringify({ id: '1', result: { text: '한글과 emoji 🙂 boundary' } }) + '\\n')`,
      `process.stdin.once('data', async () => {`,
      `  for (let i = 0; i < msg.length; i++) {`,
      `    process.stdout.write(msg.subarray(i, i + 1))`,
      `    if (i % 7 === 0) await new Promise((r) => setTimeout(r, 1))`,
      `  }`,
      `  setTimeout(() => process.exit(0), 200)`,
      `})`,
    ].join('\n')
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { command: process.execPath, args: ['-e', fake] },
    )
    try {
      const res = await client.request<{ text: string }>('probe', {}, 15_000)
      expect(res.text).toBe('한글과 emoji 🙂 boundary')
    } finally {
      await client.dispose()
    }
  })
})
