import { join } from 'node:path'
import { isObj } from '../../json-value.js'
import { PrivateJsonFile } from './private-json-file.js'

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
  /*
   * An unreadable file is moved aside, not overwritten (#841 item 2): it used to read as empty, and
   * the next `set()` replaced it, so one damaged byte cost every app every value. Moving it aside
   * rather than refusing every `set()` until a person repairs it by hand: the copy aside keeps the
   * values for whoever wants them back, and re-entering a key on the screen is the fix a person can
   * actually reach. `set()` is refused only while the file could not be moved and is still in place.
   */
  private file: PrivateJsonFile<SecretsDoc>

  constructor(dataRoot: string) {
    this.file = new PrivateJsonFile(join(dataRoot, SECRETS_FILE), {
      label: SECRETS_FILE,
      empty: () => ({}),
      valid: (doc): doc is SecretsDoc => isObj(doc),
      lost: 'Apps start without secrets until they are entered again',
    })
  }

  /** All values stored for this app (regardless of declaration) */
  all(appKey: string): Record<string, string> {
    return { ...(this.file.read()[appKey] ?? {}) }
  }

  /**
   * The names that have a value stored for this app — **never carries the values.** This is what
   * the app list uses to show "which secrets are set" (E, the secrets section). Since the list gets
   * re-read on every broadcast, the return type itself prevents a value-carrying object from ever
   * reaching the list side.
   */
  names(appKey: string): Set<string> {
    return new Set(Object.keys(this.file.read()[appKey] ?? {}))
  }

  /** The values to hand to the app — only the names its manifest declares */
  forApp(appKey: string, declared: readonly string[]): Record<string, string> {
    const stored = this.file.read()[appKey] ?? {}
    const out: Record<string, string> = {}
    for (const name of declared) {
      const v = stored[name]
      if (typeof v === 'string') out[name] = v
    }
    return out
  }

  /** Writes a value (`value`) or clears it (`null`) */
  set(appKey: string, name: string, value: string | null): void {
    const doc = this.file.read()
    const cur = { ...(doc[appKey] ?? {}) }
    if (value === null) delete cur[name]
    else cur[name] = value
    if (Object.keys(cur).length === 0) delete doc[appKey]
    else doc[appKey] = cur
    this.file.write(doc)
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
/** The shortest line of a multi-line secret masked on its own: a PEM line is 64, a JSON key's line longer */
export const SECRET_LINE_MIN_CHARS = 16

export function redactor(secrets: Record<string, string>): (text: string) => string {
  /*
   * Each value also in its JSON-escaped form (#838): a run record keeps the arguments as JSON (`describeArgs`), where
   * a value with a line break, a quote, a backslash or a control character is spelled differently (`\n`, `\"`), so a
   * multi-line key (a PEM, a service account's JSON) passed as an argument was kept unmasked. Both forms are sorted
   * together, longest first, by the same rule as the values.
   *
   * And each line of a multi-line value on its own (#838 review): the app's log is masked a line at a time (`AppLog`),
   * so a PEM printed raw never matched the whole value, and every line of the key went to the log. A line shorter than
   * `SECRET_LINE_MIN_CHARS` is left out, as a short value is: `}` or an empty line would mask half the log.
   */
  const pairs = Object.entries(secrets)
    .filter(([, v]) => v.length >= 4)
    .flatMap(([name, v]): [string, string][] => {
      const escaped = JSON.stringify(v).slice(1, -1)
      const forms: [string, string][] = escaped === v ? [[name, v]] : [[name, v], [name, escaped]]
      // A value with a line break in it, however many of its lines are long enough to mask (#945 review)
      if (!/[\r\n]/.test(v)) return forms
      const lines = v.split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l.length >= SECRET_LINE_MIN_CHARS)
      return [...forms, ...lines.map((l): [string, string] => [name, l])]
    })
    .sort((a, b) => b[1].length - a[1].length)
  if (pairs.length === 0) return (t) => t
  return (text) => {
    let out = text
    for (const [name, value] of pairs) out = out.split(value).join(`[redacted:${name}]`)
    return out
  }
}
