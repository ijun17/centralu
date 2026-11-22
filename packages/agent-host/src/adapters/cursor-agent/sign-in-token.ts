import { z } from 'zod'
import type { CursorSignInStore } from '../../os.js'
import { execText } from '../../os/exec.js'
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
 * cursor-agent's access token, read for one request and never kept (docs/security-boundaries/credentials.md "Cursor's
 * sign-in"). The Keychain answers it with a newline (measured, macOS, 2026.11.22: no prompt from the host's children);
 * a missing or locked item falls through to the file. Failures say where they stopped, never what was read
 */
export async function readCursorToken(store: CursorSignInStore, io: TokenIo = REAL_IO): Promise<string> {
  let keychainDetail = ''
  if (store.keychain) {
    const { program, service, account } = store.keychain
    try {
      const token = (await io.run(program, ['find-generic-password', '-a', account, '-s', service, '-w'])).trim()
      if (token) return token
      keychainDetail = 'keychain item empty; '
    } catch (e) {
      keychainDetail = `keychain ${exitOf(e)}; `
    }
  }
  let text: string
  try {
    text = await io.readText(store.file)
  } catch (e) {
    throw new CursorUsageFailure('no-token', `${keychainDetail}auth file ${codeOf(e)}`)
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

function exitOf(e: unknown): string {
  const ended = field(e, 'ended')
  if (typeof ended === 'string') return `ended by its ${ended}`
  const code = field(e, 'code')
  return typeof code === 'number' ? `exit ${code}` : 'did not run'
}

function codeOf(e: unknown): string {
  const code = field(e, 'code')
  return typeof code === 'string' ? code : 'unreadable'
}

function field(e: unknown, name: 'code' | 'ended'): unknown {
  const value: unknown = typeof e === 'object' && e !== null ? Object.getOwnPropertyDescriptor(e, name)?.value : undefined
  return value
}
