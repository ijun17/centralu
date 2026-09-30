import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The values behind app secrets (M4 A-3, from the plan "data and secrets live outside the
 * repository").
 *
 * The manifest lists **only the names** (since it gets committed and shared with the team). Values
 * live in a single mode-0600 file in this machine's host data folder — v1 uses a file instead of the
 * keychain (the plan allows either). Each app gets its own section, and only the names an app
 * **declares** are put into that app's environment: even if a value is stored, removing its name
 * from the manifest means the app no longer receives it.
 *
 * This file never writes a value anywhere (logs, the run ledger, error text). Masking values is the
 * writer's job (`redactor`) — it lives here because this is where the list of values to mask is
 * known.
 */

export const SECRETS_FILE = 'app-secrets.json'

type SecretsDoc = Record<string, Record<string, string>>

export class SecretStore {
  private path: string

  constructor(dataRoot: string) {
    this.path = join(dataRoot, SECRETS_FILE)
  }

  /** All values stored for this app (regardless of declaration) */
  all(appKey: string): Record<string, string> {
    return { ...(this.read()[appKey] ?? {}) }
  }

  /**
   * The names that have a value stored for this app — **never carries the values.** This is what
   * the app list uses to show "which secrets are set" (E, the secrets section). Since the list gets
   * re-read on every broadcast, the return type itself prevents a value-carrying object from ever
   * reaching the list side.
   */
  names(appKey: string): Set<string> {
    return new Set(Object.keys(this.read()[appKey] ?? {}))
  }

  /** The values to hand to the app — only the names its manifest declares */
  forApp(appKey: string, declared: readonly string[]): Record<string, string> {
    const stored = this.read()[appKey] ?? {}
    const out: Record<string, string> = {}
    for (const name of declared) {
      const v = stored[name]
      if (typeof v === 'string') out[name] = v
    }
    return out
  }

  /** Writes a value (`value`) or clears it (`null`) */
  set(appKey: string, name: string, value: string | null): void {
    const doc = this.read()
    const cur = { ...(doc[appKey] ?? {}) }
    if (value === null) delete cur[name]
    else cur[name] = value
    if (Object.keys(cur).length === 0) delete doc[appKey]
    else doc[appKey] = cur
    /*
     * The temp file is created **at 0600 from the start** and then moved into place. Writing first
     * and chmod-ing afterward would leave a window where it is readable at the default permissions
     * (usually 0644). Tightening it once more after the move covers the case where someone had
     * already loosened the permissions on an existing file.
     */
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 })
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
  }

  private read(): SecretsDoc {
    if (!existsSync(this.path)) return {}
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as SecretsDoc) : {}
    } catch {
      // A corrupt file is treated as empty — better for an app to say "no secrets" than to guess at values
      console.error(`[apps] ${SECRETS_FILE} is unreadable; apps start without secrets`)
      return {}
    }
  }
}

/**
 * The cap on the length of a value a person enters (E, the secrets section). An API key or token
 * runs to a few hundred characters, a PEM key to a few KiB. Since this value gets passed as an
 * environment variable, a larger cap would enlarge the entire environment the app's command line
 * starts with.
 */
export const SECRET_VALUE_MAX_CHARS = 16 * 1024

/**
 * The problem with a value someone wants to set — null if there is none. **Never carries the value
 * in the message**: this message travels all the way to the screen as an RPC error.
 *
 * An empty value is not accepted. Clearing has its own separate `null`, and treating an empty string
 * as "set" would leave the list saying "present" while the app receives an empty variable and fails
 * with "no key". A NUL character cannot be carried in an environment variable (spawn rejects it).
 */
export function secretValueProblem(value: string): string | null {
  if (value.length === 0) return 'Enter a value, or clear the secret instead'
  if (value.length > SECRET_VALUE_MAX_CHARS) return `A secret can be at most ${SECRET_VALUE_MAX_CHARS} characters`
  if (value.includes('\0')) return 'A secret cannot contain a NUL character'
  return null
}

/**
 * Builds a function that replaces secret values with `[redacted:name]`. If there are no values,
 * returns the identity function.
 *
 * Longer values are replaced first — if one secret is a substring of another (a token and its
 * prefix), replacing the shorter one first would leave the remainder of the longer one exposed.
 * Values shorter than 4 characters are never masked: masking a value like `a` or `1` would turn the
 * whole record into confetti, and a value that short is not meaningful as a secret anyway.
 */
export function redactor(secrets: Record<string, string>): (text: string) => string {
  const pairs = Object.entries(secrets)
    .filter(([, v]) => v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
  if (pairs.length === 0) return (t) => t
  return (text) => {
    let out = text
    for (const [name, value] of pairs) out = out.split(value).join(`[redacted:${name}]`)
    return out
  }
}
