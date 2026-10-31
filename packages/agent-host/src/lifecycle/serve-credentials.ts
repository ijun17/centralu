import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { asObj } from '../json-value.js'
import { errnoCode } from '../os/errors.js'
import { sleepSync } from '../timing.js'
import { parseLinkPublicKey } from '../transport/link-keys.js'
import { CREDENTIAL_ID_RE, CREDENTIAL_LABEL_RE } from './credential-id.js'

export { CREDENTIAL_ID_RE, CREDENTIAL_LABEL_RE }

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
const VERIFIER_RE = /^[0-9a-f]{64}$/

/** Whether one entry of the file is a full credential this host takes (`CREDENTIAL_ID_RE`) */
export function isListedEntry(f: Record<string, unknown>): f is Record<string, unknown> & { id: string; label: string; verifier: string } {
  return (
    typeof f.id === 'string' && CREDENTIAL_ID_RE.test(f.id) &&
    typeof f.label === 'string' && CREDENTIAL_LABEL_RE.test(f.label) &&
    typeof f.verifier === 'string' && VERIFIER_RE.test(f.verifier)
  )
}

/**
 * Whether one entry of `keys` is a hub's public key this host takes (#1711, docs/plans/key-pairing.md §4.2): the listed
 * id and label, and a public key `parseLinkPublicKey` takes. One with a refused key (a small-order or non-canonical one,
 * written by hand) is absent: it makes no socket full and is not listed (§4.1)
 */
export function isKeyEntry(f: Record<string, unknown>): f is Record<string, unknown> & { id: string; label: string; publicKey: string } {
  return (
    typeof f.id === 'string' && CREDENTIAL_ID_RE.test(f.id) &&
    typeof f.label === 'string' && CREDENTIAL_LABEL_RE.test(f.label) &&
    parseLinkPublicKey(f.publicKey) !== null
  )
}

/**
 * A hub's key entry (#1711, `centralu serve --connection --pair-key`): the hub's Ed25519 public key, which the hub signs
 * the link transcript with (`transport/link-proof.ts`). Public: nothing in it opens the host. A socket in under it stays
 * full while an entry with its id **and** its public key is listed (`HostServer` `sweepWithdrawn`). It has no `via`: it
 * is full whatever the file says of it, so nothing in it may keep `UsedCredentials` from recording it (#1717 review, M1)
 */
export type KeyCredential = {
  id: string
  label: string
  /** 43 characters of base64url, checked by `parseLinkPublicKey` */
  publicKey: string
  created?: number
  replaced?: boolean
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
 * What a hub can check about a credential without being handed its verifier (#1405 review): an HMAC, under that
 * verifier, of a nonce the hub chose for this read. A hub holds the credentials it paired, so it computes the same for
 * each; an entry that carries its id but another secret (one written into `serve.json` by hand, or paired by another
 * under a reused id) does not match, and is not the hub's own. The label differs from the host proof's, so this is not
 * a proof of the host to anyone
 */
export function credentialCheck(verifier: string, nonce: string): string {
  return createHmac('sha256', verifier).update(`centralu credential check v1\0${nonce}`).digest('base64url')
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
  /** The hubs' key entries (#1711): `keys`, what a key hello is checked against, and `openKeys`, what a socket in under one may keep. Absent: none */
  keys?: KeyCredential[]
  openKeys?: KeyCredential[]
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
      code = errnoCode(e) ?? 'EUNREADABLE'
      continue
    }
    refusedSince.delete(path)
    const o = asObj(parsed)
    if (o.v !== 2 || !Array.isArray(o.full)) {
      lastRead.delete(path)
      return { full: [], open: [], unreadable: null, keys: [], openKeys: [] }
    }
    const full = o.full.flatMap((e: unknown) => {
      const f = asObj(e)
      if (!isListedEntry(f)) return []
      const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
      return [{ id: f.id, label: f.label, verifier: f.verifier, created, replaced: f.replaced === true, ...(typeof f.via === 'string' ? { via: f.via } : {}) }]
    })
    const keys = readKeyEntries(o.keys, full)
    lastRead.set(path, { full, keys, at: now() })
    return { full, open: full, unreadable: null, keys, openKeys: keys }
  }
  if (code === 'ENOENT') {
    lastRead.delete(path)
    refusedSince.delete(path)
    return { full: [], open: [], unreadable: null, keys: [], openKeys: [] }
  }
  const since = refusedSince.get(path) ?? now()
  refusedSince.set(path, since)
  const last = lastRead.get(path)
  const kept = last && now() - last.at <= LAST_READ_KEPT_MS ? last : null
  return { full: [], open: kept?.full ?? [], unreadable: { code, since }, keys: [], openKeys: kept?.keys ?? [] }
}

/**
 * The key entries of a version 2 file's `keys` (#1711), each of the shape `isKeyEntry` takes and no other. Additive: a
 * file without `keys` (every launcher before key pairing writes none) names none.
 *
 * Nor one whose id a verifier entry of `full` has (#1717 recheck, F1): a key entry has no secret, so a hub told of it has
 * no `check` to tell it from its own credential of that id, and an entry written by hand under the hub's id would be
 * full here and unseen on its row. The launcher draws a key entry's id apart from every other entry's (`freshId`), so the
 * clash comes from a file written by hand, or from a verifier entry's 32-bit draw that happens to be a key entry's id; the
 * verifier entry keeps the id, and the next `--pair-key` gives the key entry another
 */
function readKeyEntries(raw: unknown, full: readonly { id: string }[]): KeyCredential[] {
  if (!Array.isArray(raw)) return []
  const verifierIds = new Set(full.map((c) => c.id))
  return raw.flatMap((e: unknown) => {
    const f = asObj(e)
    if (!isKeyEntry(f) || verifierIds.has(f.id)) return []
    const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
    // No `via` is kept: a key entry is full whatever the file says of it, so nothing in it may hide it from `UsedCredentials` (#1717 review, M1)
    return [{ id: f.id, label: f.label, publicKey: f.publicKey, created, replaced: f.replaced === true }]
  })
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
export type ListedCredential = { id: string; label: string; created: number; replaced: boolean; gone?: boolean; check?: string; publicKey?: string }

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
 * review). At most `max` are kept, the one used longest ago dropped first. A restart of this host reads them back from the file it keeps beside `serve.json` (#1712, `UsedCredentialsFile`).
 */
export class UsedCredentials {
  private seq = 0
  private rank = 0
  // By id and verifier, or id and public key (#1711): an id another secret or key reused is a second entry, not the first one overwritten (#1405 review)
  private readonly used = new Map<string, Kept>()

  constructor(private readonly max = 256) {}

  /**
   * A socket said hello with `c`, a full credential or a hub's key entry (#1711). The record when this is the first use
   * of this credential (this id under this verifier, or under this public key) that this host knows of, here or in the
   * file it kept (`load`): the caller writes it down and tells the hubs (#1712). Null for one already known, and for the
   * launcher's own one-call verifier entry (`via: handover`), which is not kept. A key entry is always kept, whatever
   * the file says of it (#1717 review, M1)
   */
  saw(c: FullCredential | KeyCredential): UsedRecord | null {
    if ('verifier' in c && c.via === 'handover') return null
    const rec: UsedRecord = { id: c.id, ...secretOf(c), label: c.label, created: c.created ?? 0, replaced: c.replaced === true }
    const key = keyOf(rec)
    if (this.used.has(key)) return null
    this.used.set(key, { ...rec, seq: ++this.seq, rank: ++this.rank })
    this.trim()
    return rec
  }

  /**
   * Takes in lines of the file (#1712), in the order they were written. A credential is one record however many lines
   * name it: it keeps the place of its first use (`seq`, which decides whose pairer again a later credential is) and
   * takes the place of its newest line in what is kept (`rank`), so that what stays is the file's newest 256 and the
   * order of the file is the order of the records, whichever way and however often it is read. A line that only says
   * when the credential was found withdrawn (`goneAt`) adds that and moves nothing; a line of a credential without it
   * that is known already is the credential named again after being withdrawn (`settle`): it forgets the note and takes
   * the newest place
   */
  load(records: readonly UsedRecord[]): void {
    for (const r of records) {
      const key = keyOf(r)
      const known = this.used.get(key)
      if (!known) this.used.set(key, { ...r, seq: ++this.seq, rank: ++this.rank })
      else {
        if (r.goneAt !== undefined) known.goneAt = Math.min(known.goneAt ?? r.goneAt, r.goneAt)
        else {
          known.rank = ++this.rank
          delete known.goneAt
        }
      }
    }
    this.trim()
  }

  /** The id of every record kept (#1712, `host.credentials` `usedIds`) */
  ids(): string[] {
    return [...new Set([...this.used.values()].map((u) => u.id))]
  }

  /** Every record kept, in the order of the file they are written to: what the file is rewritten from when it grows past `max` */
  records(): UsedRecord[] {
    return [...this.used.values()].sort((a, b) => a.rank - b.rank).map(({ seq: _seq, rank: _rank, ...r }) => r)
  }

  /**
   * Notes which records `listed` (what `serve.json` names now) no longer holds and had not been seen without it, with
   * `now` as when they were withdrawn, and drops those withdrawn `WITHDRAWN_KEPT_MS` ago or more (#1712). Returns the
   * records newly noted, for the file to be told, and how many were dropped. A credential still named keeps its record
   * and loses a note of being withdrawn: one named again (a restored `serve.json`) starts a new week when it is next
   * withdrawn, and not at the old note. Those are returned as `restored`, for the file to be told too
   */
  settle(listed: readonly { id: string; verifier?: string; publicKey?: string }[], now: number): { noted: UsedRecord[]; restored: UsedRecord[]; dropped: number } {
    const noted: UsedRecord[] = []
    const restored: UsedRecord[] = []
    let dropped = 0
    for (const [key, u] of this.used) {
      if (listed.some((c) => c.id === u.id && sameSecretOf(c, u))) {
        if (u.goneAt !== undefined) {
          delete u.goneAt
          u.rank = ++this.rank
          restored.push(plainRecord(u))
        }
        continue
      }
      if (u.goneAt === undefined) {
        u.goneAt = now
        noted.push({ ...plainRecord(u), goneAt: now })
      } else if (now - u.goneAt >= WITHDRAWN_KEPT_MS) {
        this.used.delete(key)
        dropped++
      }
    }
    return { noted, restored, dropped }
  }

  private trim(): void {
    if (this.used.size <= this.max) return
    // The one whose newest line is the oldest first
    const byRank = [...this.used].sort(([, a], [, b]) => a.rank - b.rank)
    for (const [key] of byRank.slice(0, this.used.size - this.max)) this.used.delete(key)
  }

  /** Those used here that `listed` no longer names and no same-way successor took the place of, as `gone` */
  gone(listed: readonly { id: string; label?: string; replaced?: boolean; verifier?: string; publicKey?: string }[], nonce?: string): ListedCredential[] {
    const all = [...this.used.values()].map((u) => [u.id, u] as const)
    return [...this.used.values()].flatMap((u) => {
      const id = u.id
      /*
       * Still listed: by id, and by verifier or public key too when the listing gives it (one under a reused id is another
       * credential, and a verifier entry never stands for a key entry of the same id, nor the other way round)
       */
      if (listed.some((c) => c.id === id && sameSecretOf(c, u))) return []
      // The next credential of its label used here, by first use
      const next = all.filter(([, s]) => s.label === u.label && s.seq > u.seq).sort(([, a], [, b]) => a.seq - b.seq)[0]
      if (next && !next[1].replaced) return []
      // Or, before any of it said hello here, the one of its label the file names now (#1405 review)
      if (!next && listed.some((c) => c.label === u.label && c.replaced === false)) return []
      return [{ id, label: u.label, created: u.created, replaced: u.replaced, gone: true, ...secretFields(u, nonce) }]
    })
  }

  /**
   * Every credential used here under a hub's label (`hub:`), listed or not, by first use (#1405 review): the hub of that
   * label tells its own from one something else paired under it, which `gone` takes for its pairer again
   */
  underHubLabels(nonce?: string): UsedUnderHubLabel[] {
    return [...this.used.values()]
      .filter((u) => u.label.startsWith('hub:'))
      .sort((a, b) => a.seq - b.seq)
      .map((u) => ({ id: u.id, label: u.label, created: u.created, ...secretFields(u, nonce) }))
  }
}

/** Whether a listed entry and a used one are the same secret: the same verifier, or the same public key; a listing that gives neither by id alone */
function sameSecretOf(c: { verifier?: string; publicKey?: string }, u: { verifier?: string; publicKey?: string }): boolean {
  if (c.verifier === undefined && c.publicKey === undefined) return true
  return u.verifier !== undefined ? c.verifier === u.verifier : c.publicKey === u.publicKey
}

/**
 * What a listing says of an entry's secret: a `credentialCheck` of its verifier, for the hub to compare (#1405 review),
 * or the public key of a key entry, which is public and which a hub compares with its own (#1711, §4.4)
 */
function secretFields(u: { verifier?: string; publicKey?: string }, nonce: string | undefined): { check?: string; publicKey?: string } {
  if (u.verifier !== undefined) return nonce ? { check: credentialCheck(u.verifier, nonce) } : {}
  return u.publicKey !== undefined ? { publicKey: u.publicKey } : {}
}

/** The secret a record is kept under: a full credential's verifier, or a key entry's public key (never both) */
function secretOf(c: { verifier?: string; publicKey?: string }): { verifier?: string; publicKey?: string } {
  return c.verifier !== undefined ? { verifier: c.verifier } : c.publicKey !== undefined ? { publicKey: c.publicKey } : {}
}

/** A credential used on this host under a hub's label (`UsedCredentials.underHubLabels`) */
export type UsedUnderHubLabel = { id: string; label: string; created: number; check?: string; publicKey?: string }

/**
 * One full credential a socket said hello with on this host (`UsedCredentials`), as the host keeps it in memory and in its file (#1712).
 * `goneAt`: when the host found `serve.json` no longer naming it (ms), absent while it does
 */
export type UsedRecord = { id: string; verifier?: string; publicKey?: string; label: string; created: number; replaced: boolean; goneAt?: number }

/** How long the record of a credential that `serve.json` no longer names is kept, from when the host found it withdrawn (#1712): 7 days */
export const WITHDRAWN_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What a record is kept under: the id and the verifier, or for a key entry (#1711) the id, `key:` and its public key, so
 * an id another secret or another key reused is another credential (a verifier is 64 hex digits, so none shares a name with a key)
 */
const keyOf = (c: { id: string; verifier?: string; publicKey?: string }): string => (c.verifier !== undefined ? `${c.id}:${c.verifier}` : `${c.id}:key:${c.publicKey}`)

/** A record as the file and the hubs have it: without the places it holds in memory or a note of being withdrawn */
function plainRecord(u: UsedRecord): UsedRecord {
  return { id: u.id, ...secretOf(u), label: u.label, created: u.created, replaced: u.replaced }
}

/** A record in memory: `seq` is the order of first use, `rank` the order of its newest line in the file */
type Kept = UsedRecord & { seq: number; rank: number }

/** One line of the file of used credentials (#1712): a record, as JSON. Lines are only ever added at the end, each ending in a newline */
export function encodeUsedRecord(r: UsedRecord): string {
  return `${JSON.stringify({ v: 1, id: r.id, ...secretOf(r), label: r.label, created: r.created, replaced: r.replaced, ...(r.goneAt !== undefined ? { goneAt: r.goneAt } : {}) })}\n`
}

/**
 * The records a file of used credentials holds (#1712): each line of the shape `encodeUsedRecord` writes and that
 * `isListedEntry` would take, in the order written. A line that is not one (cut short by a stop in the middle of a
 * write, or written by hand) is skipped, and no other line is lost with it
 */
export function parseUsedRecords(text: string): UsedRecord[] {
  return text.split('\n').flatMap((line): UsedRecord[] => {
    if (line.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    const f = asObj(parsed)
    if (f.v !== 1) return []
    const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
    const goneAt = typeof f.goneAt === 'number' && Number.isFinite(f.goneAt) && f.goneAt > 0 ? f.goneAt : undefined
    const rest = { created, replaced: f.replaced === true, ...(goneAt !== undefined ? { goneAt } : {}) }
    // One secret: a verifier (a full credential) or a public key (a hub's key entry, #1711), never both and never neither
    if (f.verifier !== undefined && f.publicKey === undefined) return isListedEntry(f) ? [{ id: f.id, verifier: f.verifier, label: f.label, ...rest }] : []
    if (f.publicKey !== undefined && f.verifier === undefined) return isKeyEntry(f) ? [{ id: f.id, publicKey: f.publicKey, label: f.label, ...rest }] : []
    return []
  })
}

/**
 * What a hub linked to this host is told when a full credential said hello (#1712, the `host_credential_used` event):
 * the record without its verifier, and a `check` of a nonce chosen here for this event, with which a hub that holds the
 * secret under that id knows it for its own (`credentialCheck`), and no one else learns the verifier from. A hub's key
 * entry (#1711) has no secret: its record names the public key, which a hub compares with its own
 */
export function usedEvent(r: UsedRecord, nonce: string = randomBytes(16).toString('base64url')) {
  const credential: { id: string; label: string; created: number; replaced: boolean; nonce?: string; check?: string; publicKey?: string } = {
    id: r.id,
    label: r.label,
    created: r.created,
    replaced: r.replaced,
    // A key entry's secret is public: its event names the public key and has no nonce or check (#1711)
    ...(r.verifier !== undefined ? { nonce, check: credentialCheck(r.verifier, nonce) } : { publicKey: r.publicKey }),
  }
  return { type: 'host_credential_used' as const, credential }
}

/**
 * What `host.credentials` answers (#1405): the full credentials the file names, and those used here and gone since
 * (`credentials`, null when the file cannot be read now: the hub keeps what it read last); the code of the error when
 * it cannot be read (`unreadable`, #1405 review), so the hub's row can say the machine's credential file cannot be
 * read; and the ids used under hub labels, for the hub of each to check against its own (`underHubLabels`)
 */
export type CredentialsReport = { credentials: ListedCredential[] | null; unreadable: string | null; usedUnderHubLabels: UsedUnderHubLabel[]; usedIds?: string[] }

/** `host.credentials` for the serve.json at `path` and the credentials used on this host (main.ts) */
export function credentialsReport(
  path: string,
  read: (p: string) => string,
  used: UsedCredentials,
  nonce?: string,
  /** Told what the file names, before the answer is made from it: where the records of withdrawn credentials are noted and expire (#1712) */
  onListed?: (listed: readonly { id: string; verifier?: string; publicKey?: string }[]) => void,
): CredentialsReport {
  // Read again when the second read finds the file readable after all (a busy moment), so the answer is not null for nothing
  let listed = readListing(path, read)
  const unreadable = listed ? null : readCredentialFile(path, read).unreadable?.code ?? null
  if (!listed && unreadable === null) listed = readListing(path, read)
  if (listed) onListed?.(listed)
  const shown = listed?.map(({ verifier, publicKey, ...c }) => ({ ...c, ...secretFields({ verifier, publicKey }, nonce) }))
  return { credentials: listed && shown ? [...shown, ...used.gone(listed, nonce)] : null, unreadable, usedUnderHubLabels: used.underHubLabels(nonce), usedIds: used.ids() }
}

/**
 * The full credentials `serve.json` names, as the launcher's `--connection` lists them (`others`), for `host.credentials`:
 * a hub reads them through its link between links, so a pairing made while the link is up shows on its row too. Null
 * when the file cannot be read now; the hub keeps what it read last.
 */
export function readListedCredentials(path: string, read: (p: string) => string): ListedCredential[] | null {
  return readListing(path, read)?.map(({ verifier: _verifier, ...c }) => c) ?? null
}

/**
 * `readListedCredentials` with each full entry's verifier, which stays on this host: only a `credentialCheck` of it
 * leaves. The hubs' key entries follow with their public keys (#1711, §4.4), which are public
 */
function readListing(path: string, read: (p: string) => string): (ListedCredential & { verifier?: string })[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(path))
  } catch {
    return null
  }
  const o = asObj(parsed)
  if (o.v !== 2 || !Array.isArray(o.full)) return null
  const full = o.full.flatMap((e: unknown) => {
    const f = asObj(e)
    if (!isListedEntry(f)) return []
    const created = typeof f.created === 'number' && Number.isFinite(f.created) ? f.created : 0
    return [{ id: f.id, label: f.label, created, replaced: f.replaced === true, verifier: f.verifier }]
  })
  const keys = readKeyEntries(o.keys, full).map((k) => ({ id: k.id, label: k.label, created: k.created ?? 0, replaced: k.replaced === true, publicKey: k.publicKey }))
  return [...full, ...keys]
}


/**
 * How long a socket already in keeps the credential a file that stays refused named at its last read
 * (`readCredentialFile`): a few seconds, for a writer or a scanner on Windows, and no longer than a full credential
 * should go on unlisted
 */
export const LAST_READ_KEPT_MS = 5_000

/** The last list read from each file and when, for a read that stays refused (`readCredentialFile`) */
const lastRead = new Map<string, { full: FullCredential[]; keys: KeyCredential[]; at: number }>()

/** Since when each file has been refused, for `unreadable` */
const refusedSince = new Map<string, number>()

/**
 * Whether `given` is one of `full` that opens the host whole, compared in constant time against each. An entry an older
 * launcher made for one `host.handover` call (`via: 'handover'`) is not (#1711, docs/plans/key-pairing.md §4.4): that
 * call takes limited rights now, and such a credential crossed a port to whatever answered the proof under the key
 */
export function isFullCredential(full: readonly FullCredential[], given: string): FullCredential | null {
  const found = matchCredential(full, given)
  return found && found.via !== 'handover' ? found : null
}

/** Whether `given` is an older launcher's one-call hand-over credential (`via: 'handover'`): limited rights, never full (§4.4) */
export function isHandoverCredential(full: readonly FullCredential[], given: string): FullCredential | null {
  const found = matchCredential(full, given)
  return found && found.via === 'handover' ? found : null
}

function matchCredential(full: readonly FullCredential[], given: string): FullCredential | null {
  const mine = Buffer.from(verifierOf(given), 'hex')
  let found: FullCredential | null = null
  for (const c of full) {
    const theirs = Buffer.from(c.verifier, 'hex')
    if (theirs.length === mine.length && timingSafeEqual(theirs, mine)) found = c
  }
  return found
}
