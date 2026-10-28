import { createHash, timingSafeEqual } from 'node:crypto'
import { asObj } from '../json-value.js'

/**
 * The full credentials of a host `centralu serve` runs (#1405): their verifiers, read from `serve.json` (the launcher's
 * `serve-files.mjs`, version 2), never the credentials themselves.
 *
 * The file holds a `key`, which the launcher hands this host on stdin and which it derives what it hands out from (the
 * limited credential, a bridge's, a probe's proof), and one entry per full credential, `{ id, label, verifier }`, the
 * verifier being the SHA-256 of the credential as hex. A hub's (`--pair hub:<name>-<key>`, at each link) and the
 * person's own window's (`--window`, on Windows) are such entries. The file is read again at each hello, and every
 * second while a socket holds a full credential (closed once its credential is gone, `HostServer`), so a pairing or a
 * revocation applies at once and a running host needs no message for it.
 *
 * What this protects: the full credentials are no longer written down anywhere. A process of this user that reads the
 * file gets the key (the limited credential, as `--connection` prints it) and the verifiers, neither of which opens
 * the host whole. It can still ask the launcher for a credential of its own (`--pair`), which the hub's machine row
 * then names: the honest limit, docs/security-boundaries.md "The remote host".
 */

/**
 * What an entry must be for the host to take it (#1405): exactly what the launcher lists and `--revoke` takes
 * (`serve-files.mjs` `parseServeState`, `serve-args.mjs` `CREDENTIAL_ID_RE` and `PAIR_LABEL_RE`), and what a hub's
 * machine row shows. An entry written into the file by hand with no label or another id would otherwise open the
 * host whole while nobody could see or withdraw it; listing is the whole defence against a pairing nobody asked for.
 */
export const CREDENTIAL_ID_RE = /^[0-9a-f]{8}$/
export const CREDENTIAL_LABEL_RE = /^[A-Za-z0-9:._-]{1,80}$/
const VERIFIER_RE = /^[0-9a-f]{64}$/

/** Whether one entry of the file is a full credential this host takes (`CREDENTIAL_ID_RE`) */
export function isListedEntry(f: Record<string, unknown>): f is { id: string; label: string; verifier: string } {
  return (
    typeof f.id === 'string' && CREDENTIAL_ID_RE.test(f.id) &&
    typeof f.label === 'string' && CREDENTIAL_LABEL_RE.test(f.label) &&
    typeof f.verifier === 'string' && VERIFIER_RE.test(f.verifier)
  )
}

/** One full credential the host accepts: its id, for the proof (`prove.credential`), who it was made for, and its verifier */
export type FullCredential = { id: string; label: string; verifier: string }

/** A full credential's verifier: the SHA-256 of it, as hex (the launcher's `verifierOf`) */
export function verifierOf(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * The full credentials `serve.json` at `path` names, read now: each entry of the listed shape (`isListedEntry`), and
 * no other. An unreadable file (a writer replacing it on Windows) is tried again a few times. Then:
 *
 * - a file that is not there (moved aside, as the launcher advises for a bad one; removed) names none, at once and from
 *   then on (#1405 review): every credential it granted ends, and the sockets in with one are closed
 *   (`HostServer` `sweepWithdrawn`). Keeping the last list here kept an old full credential open after the person
 *   moved the file aside;
 * - one that is there but stays refused (a scanner holding it on Windows) names what it said last, for at most
 *   `LAST_READ_KEPT_MS` since that read, rather than refusing every hub and closing every link over a busy file; past
 *   that, none;
 * - one that reads but is not version 2 names none.
 *
 * A hello is then refused rather than let in on a guess. `read` is the caller's (the file as text): this module does
 * not touch the OS (#1599).
 */
export function readFullCredentials(
  path: string,
  read: (p: string) => string,
  pause: (ms: number) => void = sleepSync,
  now: () => number = Date.now,
): FullCredential[] {
  let missing = false
  for (let i = 0; i < 5; i++) {
    if (i > 0) pause(10 * i)
    let parsed: unknown
    try {
      parsed = JSON.parse(read(path))
    } catch (e) {
      missing = asObj(e).code === 'ENOENT'
      continue
    }
    const o = asObj(parsed)
    if (o.v !== 2 || !Array.isArray(o.full)) {
      lastRead.delete(path)
      return []
    }
    const full = o.full.flatMap((e: unknown) => {
      const f = asObj(e)
      return isListedEntry(f) ? [{ id: f.id, label: f.label, verifier: f.verifier }] : []
    })
    lastRead.set(path, { full, at: now() })
    return full
  }
  const last = lastRead.get(path)
  if (missing || !last || now() - last.at > LAST_READ_KEPT_MS) {
    lastRead.delete(path)
    return []
  }
  return last.full
}

/** How long a list read last stands for a file that is there but stays refused (`readFullCredentials`) */
export const LAST_READ_KEPT_MS = 30_000

/** The last list read from each file and when, for a read that stays refused (`readFullCredentials`) */
const lastRead = new Map<string, { full: FullCredential[]; at: number }>()

/** Waits `ms` on this thread: the reads are a few milliseconds apart, at a hello, and the host has no other wait here */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Whether `given` is one of `full`, compared in constant time against each */
export function isFullCredential(full: readonly FullCredential[], given: string): FullCredential | null {
  const mine = Buffer.from(verifierOf(given), 'hex')
  let found: FullCredential | null = null
  for (const c of full) {
    const theirs = Buffer.from(c.verifier, 'hex')
    if (theirs.length === mine.length && timingSafeEqual(theirs, mine)) found = c
  }
  return found
}
