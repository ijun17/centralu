import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { asObj } from '../json-value.js'

/**
 * The full credentials of a host `centralu serve` runs (#1405): their verifiers, read from `serve.json` (the launcher's
 * `serve-files.mjs`, version 2), never the credentials themselves.
 *
 * The file holds a `key`, which the launcher hands this host on stdin and which it derives what it hands out from (the
 * limited credential, a bridge's, a probe's proof), and one entry per full credential, `{ id, label, verifier }`, the
 * verifier being the SHA-256 of the credential as hex. A hub's (`--pair hub:<id>`, at each link) and the person's own
 * window's (`--window`, on Windows) are such entries. The file is read again at each hello, so a pairing or a
 * revocation applies at once and a running host needs no message for it.
 *
 * What this protects: the full credentials are no longer written down anywhere. A process of this user that reads the
 * file gets the key (the limited credential, as `--connection` prints it) and the verifiers, neither of which opens
 * the host whole. It can still ask the launcher for a credential of its own (`--pair`), which the hub's machine row
 * then names: the honest limit, docs/security-boundaries.md "The remote host".
 */

/** One full credential the host accepts: its id, for the proof (`prove.credential`), and its verifier */
export type FullCredential = { id: string; verifier: string }

/** A full credential's verifier: the SHA-256 of it, as hex (the launcher's `verifierOf`) */
export function verifierOf(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * The full credentials `serve.json` at `path` names, read now. An unreadable file (a writer replacing it on Windows) is
 * tried again a few times; one that stays unreadable, or is not version 2, names none: a hello is then refused rather
 * than let in on a guess.
 */
export function readFullCredentials(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8'), pause: (ms: number) => void = sleepSync): FullCredential[] {
  for (let i = 0; i < 5; i++) {
    if (i > 0) pause(10 * i)
    let parsed: unknown
    try {
      parsed = JSON.parse(read(path))
    } catch {
      continue
    }
    const o = asObj(parsed)
    if (o.v !== 2 || !Array.isArray(o.full)) return []
    const full = o.full.flatMap((e: unknown) => {
      const f = asObj(e)
      return typeof f.id === 'string' && typeof f.verifier === 'string' && /^[0-9a-f]{64}$/.test(f.verifier) ? [{ id: f.id, verifier: f.verifier }] : []
    })
    lastRead.set(path, full)
    return full
  }
  // Held past the retries (a scanner on Windows): what it said last, rather than refusing every hub until it lets go
  return lastRead.get(path) ?? []
}

/** The last list read from each file, for a read that stays refused (`readFullCredentials`) */
const lastRead = new Map<string, FullCredential[]>()

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
