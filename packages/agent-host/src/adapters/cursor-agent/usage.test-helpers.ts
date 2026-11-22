import { CursorUsageFailure } from './usage-failure.js'

/** The failure a read ends in, for the test to look at its kind and detail; anything else fails the test */
export async function failureOf(read: Promise<unknown> | (() => unknown)): Promise<CursorUsageFailure> {
  try {
    await (typeof read === 'function' ? read() : read)
  } catch (e) {
    if (e instanceof CursorUsageFailure) return e
    throw e
  }
  throw new Error('did not fail')
}

/** A token shaped as Cursor's (a JWT) carrying these claims; never a real one */
export function jwt(claims: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}
