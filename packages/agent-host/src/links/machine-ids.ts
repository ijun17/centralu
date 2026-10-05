import { randomBytes } from 'node:crypto'
import { MACHINE_ID_RE } from '@cc/protocol'

/**
 * Machine-qualified ids (remote mode as linked hosts, docs/plans/remote-hub.md §3.3).
 *
 * A hub shows a linked machine's ids to its UI as `<machine>.<id>`. The protocol's id pattern
 * (`SESSION_ID_RE`) already allows `.` after the first character, every id this host generates is
 * a UUID or a counter without a dot, and every parser in the UI splits on `/` or `:`, so a
 * qualified id passes through the UI unchanged. A machine id never contains a dot, so the first
 * dot always ends it.
 *
 * Numbers cannot carry a prefix. The ones the UI hands back to the hub (approval rule ids) are
 * folded into negative numbers instead: no local row id is ever negative, so a UI that does not know
 * about machines can never delete a local rule by sending a remote one's number (`encodeNumber`).
 */

export function isMachineId(value: string): boolean {
  return MACHINE_ID_RE.test(value)
}

export function qualify(machine: string, id: string): string {
  return `${machine}.${id}`
}

/** `<machine>.<id>` split at its first dot, or null for an id with no machine-shaped prefix */
export function splitQualified(value: string): { machine: string; id: string } | null {
  const dot = value.indexOf('.')
  if (dot <= 0 || dot === value.length - 1) return null
  const machine = value.slice(0, dot)
  return isMachineId(machine) ? { machine, id: value.slice(dot + 1) } : null
}

/**
 * The room one machine gets in the negative numbers. Row ids and pids stay far below 2^32 (SQLite
 * rowids of rules number in the hundreds; Linux pids stop at 2^22), and 2^53 / 2^32 leaves room for
 * two million machine slots, so the fold is exact.
 */
const SLOT = 2 ** 32

/** A remote number as the hub's UI sees it: negative, unique per (slot, n). Slots start at 1 */
export function encodeNumber(slot: number, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n >= SLOT) throw new Error(`Cannot qualify the number ${n}`)
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error(`Not a machine slot: ${slot}`)
  return -(slot * SLOT + n)
}

/** The inverse of `encodeNumber`, or null for a number that was never folded (a local one) */
export function decodeNumber(value: number): { slot: number; n: number } | null {
  if (!Number.isSafeInteger(value) || value >= 0) return null
  const v = -value
  const slot = Math.floor(v / SLOT)
  if (slot < 1) return null
  return { slot, n: v - slot * SLOT }
}

/** A machine id from the name the person gave, made unique: `ubuntu`, `ubuntu-2`, or a random one */
export function newMachineId(name: string, taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24)
  const base = slug && MACHINE_ID_RE.test(slug) ? slug : `m-${randomBytes(3).toString('hex')}`
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `m-${randomBytes(4).toString('hex')}`
}
