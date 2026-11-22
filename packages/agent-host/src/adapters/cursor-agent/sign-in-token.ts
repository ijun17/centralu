import { z } from 'zod'
import type { CursorSignInStore } from '../../os.js'
import { errnoCode } from '../../os/errors.js'
import { execText, isExecFailure } from '../../os/exec.js'
import { realOs } from '../../os/real.js'
import { CursorUsageFailure } from './usage-failure.js'

export type TokenIo = {
  /** A program's stdout; throws when it exits other than 0 */
  run(program: string, args: readonly string[]): Promise<string>
  readText(path: string): Promise<string>
}

/** The Keychain answered in under 1 s (measured, macOS); a locked or stuck one must not hold the usage answer */
const KEYCHAIN_MS = 3_000

const REAL_IO: TokenIo = {
  run: async (program, args) => (await execText(program, args, { timeoutMs: KEYCHAIN_MS })).stdout,
  readText: (path) => realOs().files.promises.readFile(path, 'utf8'),
}

const AUTH_FILE = z.object({ accessToken: z.string().min(1) })
const JWT_CLAIMS = z.object({ exp: z.number().finite().optional() })

/**
 * cursor-agent's access token, read for each request and never kept (docs/security-boundaries/credentials.md "Cursor's
 * sign-in"). The Keychain answers it with a newline (measured, macOS, 2026.11.22: no prompt from the host's children);
 * a missing or locked item falls through to the file. A read that runs out of time is what a prompt waiting looks like,
 * so the Keychain is not asked again in this process. Failures say where they stopped, never what was read
 */
export function cursorTokenReader(store: CursorSignInStore, io: TokenIo = REAL_IO): () => Promise<string> {
  let keychainHeld = false
  return async () => {
    let keychainDetail = ''
    if (store.keychain && keychainHeld) keychainDetail = 'keychain skipped after its timeout; '
    else if (store.keychain) {
      const { program, service, account } = store.keychain
      try {
        const token = (await io.run(program, ['find-generic-password', '-a', account, '-s', service, '-w'])).trim()
        if (token) return token
        keychainDetail = 'keychain item empty; '
      } catch (e) {
        keychainHeld = isExecFailure(e) && e.ended === 'timeout'
        keychainDetail = `keychain ${!isExecFailure(e) ? 'did not run' : e.ended ? `ended by its ${e.ended}` : `exit ${String(e.code)}`}; `
      }
    }
    return fileToken(store.file, keychainDetail, io)
  }
}

async function fileToken(file: string, keychainDetail: string, io: TokenIo): Promise<string> {
  let text: string
  try {
    text = await io.readText(file)
  } catch (e) {
    throw new CursorUsageFailure('no-token', `${keychainDetail}auth file ${errnoCode(e) ?? 'unreadable'}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CursorUsageFailure('no-token', `${keychainDetail}auth file is not JSON`)
  }
  const auth = AUTH_FILE.safeParse(json)
  if (!auth.success) throw new CursorUsageFailure('no-token', `${keychainDetail}auth file has no accessToken`)
  return auth.data.accessToken
}

/** When the token stops being accepted (its JWT `exp`, ms), or null when it does not say: the server then decides */
export function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JWT_CLAIMS.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return claims.success && claims.data.exp !== undefined ? claims.data.exp * 1000 : null
  } catch {
    return null
  }
}
