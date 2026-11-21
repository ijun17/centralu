import { randomBytes } from 'node:crypto'
import { MACHINE_ID_RE } from '@cc/protocol'
import { ROLE_WORDS } from '../mail/address.js'

/**
 * Machine-qualified ids (remote mode as linked hosts, docs/plans/remote-hub.md §3.3). A hub shows a linked machine's ids to its
 * UI as `<machine>.<id>`: the protocol's id pattern (`SESSION_ID_RE`) allows `.` after the first character, every id this host
 * generates is a UUID or a counter without a dot, and the UI's parsers split on `/` or `:`, so a qualified id passes through
 * unchanged. A machine id never contains a dot, so the first dot always ends it. Numbers cannot carry a prefix: the ones the UI
 * hands back (approval rule ids) are folded into negative numbers, and no local row id is ever negative, so a UI that does not
 * know about machines can never delete a local rule by sending a remote one's number (`encodeNumber`).
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

/** The machine of `machines` with this id */
export function findMachine<M extends { id: string }>(machines: Iterable<M>, id: string): M | null {
  for (const m of machines) if (m.id === id) return m
  return null
}

/** The machine of `machines` a qualified id names, with the id inside it; null for an id with no such machine (the hub's own) */
export function qualifiedMachine<M extends { id: string }>(machines: Iterable<M>, value: string): { machine: M; id: string } | null {
  const split = splitQualified(value)
  const machine = split ? findMachine(machines, split.machine) : null
  return split && machine ? { machine, id: split.id } : null
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
  return unique(slugOf(name) ?? `m-${randomBytes(3).toString('hex')}`, taken) ?? `m-${randomBytes(4).toString('hex')}`
}

/**
 * The prefix a hub's own sessions go under on its machines, as `<machine>.<id>` names a machine's on the hub: from its name,
 * never one of its machines' ids or a role word, and the same at every offer while neither changes. Display only: mail
 * stores and sends addresses, so a renamed hub breaks no stored reference
 */
export function hubLabel(name: string, machines: Iterable<string>): string {
  return unique(slugOf(name) ?? 'hub', new Set([...machines, ...ROLE_WORDS])) ?? 'hub'
}

/** This hub's own label (`hubLabel`) over every machine it links: what its offer gives them and its mail writes for them. null on a host that is no hub */
export function ownHubLabel(d: { hubSelf?: () => { name: string }; registry: { list(): readonly { id: string }[] } }): string | null {
  const self = d.hubSelf?.()
  return self ? hubLabel(self.name, d.registry.list().map((r) => r.id)) : null
}

/**
 * The label this host shows a hub that links it under: the one it offered (made from its name when an older hub offered none), suffixed as
 * `hubLabel` does when it is one of `taken` (this host's own machines' ids, which `<label>.<id>` would name first). Worked out at each read from
 * what is kept (the offer, this host's machines), so it holds across restarts while neither changes
 */
export function labelHere(offered: string | null, name: string, taken: Iterable<string>): string {
  const t = new Set([...taken, ...ROLE_WORDS])
  return (offered === null ? null : unique(offered, t)) ?? hubLabel(name, t)
}

function slugOf(name: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24)
  return slug && MACHINE_ID_RE.test(slug) ? slug : null
}

function unique(base: string, taken: ReadonlySet<string>): string | null {
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return null
}
