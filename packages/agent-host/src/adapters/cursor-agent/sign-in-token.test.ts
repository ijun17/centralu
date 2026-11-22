import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CursorSignInStore } from '../../os.js'
import { readCursorToken, tokenExpiry, type TokenIo } from './sign-in-token.js'
import { CursorUsageFailure } from './usage-failure.js'

async function failureOf(p: Promise<unknown>): Promise<CursorUsageFailure> {
  try {
    await p
  } catch (e) {
    if (e instanceof CursorUsageFailure) return e
    throw e
  }
  throw new Error('did not fail')
}

describe("reading cursor-agent's token from its file (#2459)", () => {
  let dir: string
  let store: CursorSignInStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-sign-in-'))
    store = { keychain: null, file: join(dir, 'auth.json') }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the access token of the file, as the CLI writes it', async () => {
    writeFileSync(store.file, JSON.stringify({ accessToken: 'tok-1', refreshToken: 'ref-1' }, null, 2))
    await expect(readCursorToken(store)).resolves.toBe('tok-1')
  })

  it('says the sign-in could not be read when the file is missing, not JSON, or has no access token, never quoting it', async () => {
    expect(await failureOf(readCursorToken(store))).toMatchObject({ kind: 'no-token', detail: 'auth file ENOENT' })
    writeFileSync(store.file, '{"accessToken":"tok-secret"')
    const notJson = await failureOf(readCursorToken(store))
    expect(notJson).toMatchObject({ kind: 'no-token', detail: 'auth file is not JSON' })
    writeFileSync(store.file, JSON.stringify({ refreshToken: 'ref-secret', accessToken: '' }))
    const noToken = await failureOf(readCursorToken(store))
    expect(noToken).toMatchObject({ kind: 'no-token', detail: 'auth file has no accessToken' })
    expect(`${notJson.detail} ${noToken.detail} ${noToken.message}`).not.toContain('secret')
  })
})

describe("reading cursor-agent's token from the macOS Keychain (#2459)", () => {
  const KEYCHAIN: CursorSignInStore = { keychain: { program: '/usr/bin/security', service: 'cursor-access-token', account: 'cursor-user' }, file: '/home/p/.cursor/auth.json' }

  function io(run: TokenIo['run'], file?: string): TokenIo & { runs: string[][]; reads: string[] } {
    const runs: string[][] = []
    const reads: string[] = []
    return {
      runs,
      reads,
      run: async (program, args) => (runs.push([program, ...args]), run(program, args)),
      readText: async (path) => {
        reads.push(path)
        if (file === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return file
      },
    }
  }

  it("asks `security` for the item's password, as the CLI names it, and strips the newline it answers with", async () => {
    const fake = io(async () => 'tok-1\n')
    await expect(readCursorToken(KEYCHAIN, fake)).resolves.toBe('tok-1')
    expect(fake.runs).toEqual([['/usr/bin/security', 'find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w']])
    expect(fake.reads).toEqual([])
  })

  it('falls through to the file when the item is missing, locked or empty', async () => {
    for (const run of [async () => Promise.reject(Object.assign(new Error('exit'), { code: 44 })), async () => Promise.reject(Object.assign(new Error('exit'), { code: 36 })), async () => '\n']) {
      const fake = io(run, '{"accessToken":"tok-file"}')
      await expect(readCursorToken(KEYCHAIN, fake)).resolves.toBe('tok-file')
      expect(fake.reads).toEqual([KEYCHAIN.file])
    }
  })

  it('says where both stopped when neither has it', async () => {
    const f = await failureOf(readCursorToken(KEYCHAIN, io(async () => Promise.reject(Object.assign(new Error('exit'), { code: 44 })))))
    expect(f).toMatchObject({ kind: 'no-token', detail: 'keychain exit 44; auth file ENOENT' })
    const notRun = await failureOf(readCursorToken(KEYCHAIN, io(async () => Promise.reject(new Error('spawn failed')))))
    expect(notRun.detail).toBe('keychain did not run; auth file ENOENT')
  })
})

describe('when a token stops being accepted (#2459)', () => {
  const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

  it('reads the exp claim of a JWT, in ms', () => {
    expect(tokenExpiry(jwt({ exp: 1_798_131_368, type: 'session' }))).toBe(1_798_131_368_000)
  })

  it('does not say when a token has no exp, or is not a JWT', () => {
    for (const token of [jwt({ sub: 'p' }), jwt({ exp: 'soon' }), jwt('text'), 'opaque', 'a.!!!.b', 'a..b']) expect(tokenExpiry(token)).toBeNull()
  })
})
