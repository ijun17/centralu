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
export function isListedEntry(f: Record<string, unknown>): f is Record<string, unknown> & { id: string; label: string; verifier: string } {
  return (
    typeof f.id === 'string' && CREDENTIAL_ID_RE.test(f.id) &&
    typeof f.label === 'string' && CREDENTIAL_LABEL_RE.test(f.label) &&
    typeof f.verifier === 'string' && VERIFIER_RE.test(f.verifier)
  )
}

/** One full credential the host accepts: its id, for the proof (`prove.credential`), who it was made for, and its verifier */
export type FullCredential = {
  id: string
  label: string
  verifier: string
  /** When it was made, and whether its pairing took the place of one asked for another way (the launcher's `pairServe`) */
  created?: number
  replaced?: boolean
  /** How it was asked for (`pair`, `window`, `handover`), when the file says */
  via?: string
}

/** A full credential's verifier: the SHA-256 of it, as hex (the launcher's `verifierOf`) */
export function verifierOf(credential: string): string {
  return createHash('sha256').update(credential).digest('hex')
}

/**
 * What one read of `serve.json` gives the host (#1405 review): `full`, what a new hello is checked against; `open`,
 * what a socket already in with a full credential may keep; and `unreadable`, set while the file is there but cannot be
 * read (permission denied, a scanner holding it), with the error's code and since when.
 */
export type CredentialsRead = {
  full: FullCredential[]
  open: FullCredential[]
  unreadable: { code: string; since: number } | null
}

/**
 * The full credentials `serve.json` at `path` names, read now: each entry of the listed shape (`isListedEntry`), and
 * no other. An unreadable file (a writer replacing it on Windows) is tried again a few times. Then:
 *
 * - a file that is not there (moved aside, as the launcher advises for a bad one; removed) names none, at once and from
 *   then on (#1405 review): every credential it granted ends, and the sockets in with one are closed
 *   (`HostServer` `sweepWithdrawn`). Keeping the last list here kept an old full credential open after the person
 *   moved the file aside;
 * - one that is there but stays refused (permission denied, or a scanner holding it on Windows) names none for a new
 *   hello, at once (#1405 review: a credential paired just before kept full rights for 30 s while no row could list
 *   it). A socket already in keeps what the file said last for at most `LAST_READ_KEPT_MS` since that read, so a
 *   busy file does not close every link at its first refused read; past that it is closed, as "credential file
 *   unreadable", not "withdrawn". `unreadable` says so, for `host.credentials` and the hub's row;
 * - one that reads but is not version 2 names none.
 *
 * A hello is then refused rather than let in on a guess. `read` is the caller's (the file as text): this module does
 * not touch the OS (#1599).
 */
export function readCredentialFile(
  path: string,
  read: (p: string) => string,
  pause: (ms: number) => void = sleepSync,
  now: () => number = Date.now,
): CredentialsRead {
  let code = ''
  for (let i = 0; i < 5; i++) {
    if (i > 0) pause(10 * i)
    let parsed: unknown
    try {
      parsed = JSON.parse(read(path))
    } catch (e) {
      const c = asObj(e).code
      code = typeof c === 'string' ? c : 'EUNREADABLE'
      continue
    }
    refusedSince.delete(path)
    const o = asObj(parsed)
    if (o.v !== 2 || !Array.isArray(o.full)) {
      lastRead.delete(path)
      return { full: [], open: [], unreadable: null }
    }
    const full = o.full.flatMap((e: unknown) => {
      const f = asObj(e)
      if (!isListedEntry(f)) return []
      const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
      return [{ id: f.id, label: f.label, verifier: f.verifier, created, replaced: f.replaced === true, ...(typeof f.via === 'string' ? { via: f.via } : {}) }]
    })
    lastRead.set(path, { full, at: now() })
    return { full, open: full, unreadable: null }
  }
  if (code === 'ENOENT') {
    lastRead.delete(path)
    refusedSince.delete(path)
    return { full: [], open: [], unreadable: null }
  }
  const since = refusedSince.get(path) ?? now()
  refusedSince.set(path, since)
  const last = lastRead.get(path)
  const open = last && now() - last.at <= LAST_READ_KEPT_MS ? last.full : []
  return { full: [], open, unreadable: { code, since } }
}

/** The full credentials a new hello is checked against now (`readCredentialFile`'s `full`) */
export function readFullCredentials(
  path: string,
  read: (p: string) => string,
  pause: (ms: number) => void = sleepSync,
  now: () => number = Date.now,
): FullCredential[] {
  return readCredentialFile(path, read, pause, now).full
}

/**
 * A full credential as a hub's machine row lists it (#1405): never its verifier. `gone`: no longer listed, but a socket
 * said hello with it on this host (`UsedCredentials`)
 */
export type ListedCredential = { id: string; label: string; created: number; replaced: boolean; gone?: boolean }

/**
 * The full credentials a socket said hello with on this host, kept while it runs (#1405 review), so that one withdrawn
 * before a hub's next `host.credentials` read is still listed there, as `gone`: before, `--pair x`, a hello and
 * `--revoke` within 135 ms left no trace on any row, so "loud" could be dodged by timing.
 *
 * Not every credential that goes is news. The window pairs again at each start, and a hub at each link, so their
 * earlier credentials go all the time. One that went is left out when the next credential of its label, the one that
 * said hello here next or the one the file names now, was paired the same way (its entry not `replaced`, the launcher's
 * `pairServe`): that is its pairer again. The file's own counts (#1405 review): a hub that had paired again but not yet
 * said hello had its previous credential listed as gone on another hub's row for one read. One whose label nothing
 * holds since, or whose successor was asked for another way, is listed. The launcher's own one-call credential (`via:
 * handover`) is not kept.
 *
 * What this cannot tell is two askers of the same way under one label (a program's `--pair hub:<name>-<key>` that the
 * hub's own next link takes the place of). So every id used under a hub's label is also given as it is (`underHubLabels`),
 * and the hub of that label compares them with the ids it paired itself: any other is one it did not make (#1405
 * review). At most `max` are kept, the oldest dropped first; a restart of this host forgets them.
 */
export class UsedCredentials {
  private seq = 0
  private readonly used = new Map<string, { label: string; created: number; replaced: boolean; seq: number }>()

  constructor(private readonly max = 256) {}

  /** A socket said hello with `c` */
  saw(c: FullCredential): void {
    if (c.via === 'handover') return
    const known = this.used.get(c.id)
    this.used.delete(c.id)
    this.used.set(c.id, { label: c.label, created: c.created ?? 0, replaced: c.replaced === true, seq: known?.seq ?? ++this.seq })
    for (const id of this.used.keys()) {
      if (this.used.size <= this.max) break
      this.used.delete(id)
    }
  }

  /** Those used here that `listed` no longer names and no same-way successor took the place of, as `gone` */
  gone(listed: readonly { id: string; label?: string; replaced?: boolean }[]): ListedCredential[] {
    const now = new Set(listed.map((c) => c.id))
    const all = [...this.used]
    return all.flatMap(([id, u]) => {
      if (now.has(id)) return []
      // The next credential of its label used here, by first use
      const next = all.filter(([, s]) => s.label === u.label && s.seq > u.seq).sort(([, a], [, b]) => a.seq - b.seq)[0]
      if (next && !next[1].replaced) return []
      // Or, before any of it said hello here, the one of its label the file names now (#1405 review)
      if (!next && listed.some((c) => c.label === u.label && c.replaced === false)) return []
      return [{ id, label: u.label, created: u.created, replaced: u.replaced, gone: true }]
    })
  }

  /**
   * Every credential used here under a hub's label (`hub:`), listed or not, by first use (#1405 review): the hub of that
   * label tells its own from one something else paired under it, which `gone` takes for its pairer again
   */
  underHubLabels(): UsedUnderHubLabel[] {
    return [...this.used]
      .filter(([, u]) => u.label.startsWith('hub:'))
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([id, u]) => ({ id, label: u.label, created: u.created }))
  }
}

/** A credential used on this host under a hub's label (`UsedCredentials.underHubLabels`) */
export type UsedUnderHubLabel = { id: string; label: string; created: number }

/**
 * What `host.credentials` answers (#1405): the full credentials the file names, and those used here and gone since
 * (`credentials`, null when the file cannot be read now: the hub keeps what it read last); the code of the error when
 * it cannot be read (`unreadable`, #1405 review), so the hub's row can say the machine's credential file cannot be
 * read; and the ids used under hub labels, for the hub of each to check against its own (`underHubLabels`)
 */
export type CredentialsReport = { credentials: ListedCredential[] | null; unreadable: string | null; usedUnderHubLabels: UsedUnderHubLabel[] }

/** `host.credentials` for the serve.json at `path` and the credentials used on this host (main.ts) */
export function credentialsReport(path: string, read: (p: string) => string, used: UsedCredentials): CredentialsReport {
  // Read again when the second read finds the file readable after all (a busy moment), so the answer is not null for nothing
  let listed = readListedCredentials(path, read)
  const unreadable = listed ? null : readCredentialFile(path, read).unreadable?.code ?? null
  if (!listed && unreadable === null) listed = readListedCredentials(path, read)
  return { credentials: listed ? [...listed, ...used.gone(listed)] : null, unreadable, usedUnderHubLabels: used.underHubLabels() }
}

/**
 * The full credentials `serve.json` names, as the launcher's `--connection` lists them (`others`), for `host.credentials`:
 * a hub reads them through its link between links, so a pairing made while the link is up shows on its row too. Null
 * when the file cannot be read now; the hub keeps what it read last.
 */
export function readListedCredentials(path: string, read: (p: string) => string): ListedCredential[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(path))
  } catch {
    return null
  }
  const o = asObj(parsed)
  if (o.v !== 2 || !Array.isArray(o.full)) return null
  return o.full.flatMap((e: unknown) => {
    const f = asObj(e)
    if (!isListedEntry(f)) return []
    const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
    return [{ id: f.id, label: f.label, created, replaced: f.replaced === true }]
  })
}


/**
 * How long a socket already in keeps the credential a file that stays refused named at its last read
 * (`readCredentialFile`): a few seconds, for a writer or a scanner on Windows, and no longer than a full credential
 * should go on unlisted
 */
export const LAST_READ_KEPT_MS = 5_000

/** The last list read from each file and when, for a read that stays refused (`readCredentialFile`) */
const lastRead = new Map<string, { full: FullCredential[]; at: number }>()

/** Since when each file has been refused, for `unreadable` */
const refusedSince = new Map<string, number>()

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
