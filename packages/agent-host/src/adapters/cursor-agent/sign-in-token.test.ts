import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CursorSignInStore } from '../../os.js'
import { realOs } from '../../os/real.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { readCursorToken, tokenExpiry, type TokenIo } from './sign-in-token.js'
import { failureOf } from '../token-limits/failure.test-helpers.js'
import { jwt } from './usage.test-helpers.js'

const { files, paths } = realOs()

describe("reading cursor-agent's token from its file (#2459)", () => {
  let dir: string
  let store: CursorSignInStore
  beforeEach(() => {
    dir = tempRoot('cursor-sign-in-')
    store = { keychain: null, file: paths.path.join(dir, 'auth.json') }
  })
  afterEach(() => removeTree(dir))

  it('reads the access token of the file, as the CLI writes it', async () => {
    files.writeFileSync(store.file, JSON.stringify({ accessToken: 'tok-1', refreshToken: 'ref-1' }, null, 2))
    await expect(readCursorToken(store)).resolves.toBe('tok-1')
  })

  it('says the sign-in could not be read when the file is missing, not JSON, or has no access token, never quoting it', async () => {
    expect(await failureOf(readCursorToken(store))).toMatchObject({ kind: 'no-token', detail: 'auth file ENOENT' })
    files.writeFileSync(store.file, '{"accessToken":"tok-secret"')
    const notJson = await failureOf(readCursorToken(store))
    expect(notJson).toMatchObject({ kind: 'no-token', detail: 'auth file is not JSON' })
    files.writeFileSync(store.file, JSON.stringify({ refreshToken: 'ref-secret', accessToken: '' }))
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

  /** `security` exits with its OSStatus's low byte: errSecItemNotFound (-25300) and errSecInteractionNotAllowed (-25308, a locked keychain) */
  const exited = (code: 44 | 36) => async () => Promise.reject(Object.assign(new Error('exit'), { code }))
  const NOT_FOUND = exited(44)
  const LOCKED = exited(36)

  it("asks `security` for the item's password, as the CLI names it, and strips the newline it answers with", async () => {
    const fake = io(async () => 'tok-1\n')
    await expect(readCursorToken(KEYCHAIN, fake)).resolves.toBe('tok-1')
    expect(fake.runs).toEqual([['/usr/bin/security', 'find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w']])
    expect(fake.reads).toEqual([])
  })

  it('falls through to the file when the item is missing, locked or empty', async () => {
    for (const run of [NOT_FOUND, LOCKED, async () =>'\n']) {
      const fake = io(run, '{"accessToken":"tok-file"}')
      await expect(readCursorToken(KEYCHAIN, fake)).resolves.toBe('tok-file')
      expect(fake.reads).toEqual([KEYCHAIN.file])
    }
  })

  it('says where both stopped when neither has it', async () => {
    const f = await failureOf(readCursorToken(KEYCHAIN, io(NOT_FOUND)))
    expect(f).toMatchObject({ kind: 'no-token', detail: 'keychain exit 44; auth file ENOENT' })
    // A locked keychain: `security` with no prompt exits, and the read says the sign-in was not found
    const locked = await failureOf(readCursorToken(KEYCHAIN, io(LOCKED)))
    expect(locked).toMatchObject({ kind: 'no-token', detail: 'keychain exit 36; auth file ENOENT' })
    const notRun = await failureOf(readCursorToken(KEYCHAIN, io(async () => Promise.reject(new Error('spawn failed')))))
    expect(notRun.detail).toBe('keychain did not run; auth file ENOENT')
    // Bounded: a Keychain that holds the read says it ran out of time, not that it did not run
    const held = await failureOf(readCursorToken(KEYCHAIN, io(async () => Promise.reject(Object.assign(new Error('timeout'), { code: null, ended: 'timeout' })))))
    expect(held.detail).toBe('keychain ended by its timeout; auth file ENOENT')
  })
})

describe('when a token stops being accepted (#2459)', () => {
  it('reads the exp claim of a JWT, in ms', () => {
    expect(tokenExpiry(jwt({ exp: 1_798_131_368, type: 'session' }))).toBe(1_798_131_368_000)
  })

  it('does not say when a token has no exp, or is not a JWT', () => {
    for (const token of [jwt({ sub: 'p' }), jwt({ exp: 'soon' }), jwt('text'), 'opaque', 'a.!!!.b', 'a..b']) expect(tokenExpiry(token)).toBeNull()
  })
})
