import type { Interruption, SessionState } from '@cc/protocol/client'
import { isWaiting } from '../session/state-machine.js'
import { isUnread, type ReadTracked } from '../unread/unread.js'

/**
 * The inbox, derived and never stored (docs/state-management.md §3); what is listed and its order: docs/product-spec.md
 * FR-15. The list, the counters, the sidebar's folded summary and "next waiting" all ask `isListedWaiting`. A pending
 * proposal (#703) is not a session state: it is listed as a `waiting_approval` candidate, so nothing needs a second rule.
 */

export type InboxCandidate = {
  id: string
  projectId: string | null
  name: string
  state: SessionState
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  preview?: string
  interruption?: Interruption | null
  /** A question the agent asked: answered rather than allowed, listed as an approval is */
  asking?: boolean
  /** This row is the proposal (#703); `id` is not a session id */
  proposal?: PendingProposal
  /** This row is the notice of an app a trusted project gained (#1141); `id` is not a session id */
  arrival?: AppArrival
}

/**
 * An app a trusted project gained (#1141), say by a `git pull`: trusted with the project, so the inbox says so once.
 * `asks` is empty for nothing beyond its own tools; `at` is when the window noted it.
 */
export type AppArrival = { key: string; projectId: string; appId: string; title: string; asks: string[]; at: number }

/** No session id has it */
export const APP_ARRIVAL_ID_PREFIX = 'app-arrival:'

export const isAppArrivalId = (id: string): boolean => id.startsWith(APP_ARRIVAL_ID_PREFIX)

/** Unread `waiting_input`, like a finished turn, so Done clears them */
export function appArrivalCandidates(arrivals: readonly AppArrival[]): InboxCandidate[] {
  return arrivals.map((a) => ({
    id: `${APP_ARRIVAL_ID_PREFIX}${a.key}`,
    projectId: a.projectId,
    name: `New app: ${a.title}`,
    state: 'waiting_input' as const,
    waitingSince: a.at,
    lastSeq: 1,
    lastReadSeq: 0,
    arrival: a,
  }))
}

/**
 * `seen`: per trusted project, its app keys when last looked at. A project not in it yet gives no notice: the person
 * trusted or made it with those apps there. An untrusted project is dropped; its trust card lists its apps if trusted again.
 */
export function noteAppArrivals(
  apps: readonly { key: string; projectId: string | null; appId: string; title: string; asks: string[] }[],
  trusted: ReadonlySet<string>,
  seen: Readonly<Record<string, readonly string[]>>,
  now: number,
): { seen: Record<string, string[]>; arrived: AppArrival[] } {
  const next: Record<string, string[]> = {}
  const arrived: AppArrival[] = []
  for (const projectId of trusted) {
    const mine = apps.filter((a) => a.projectId === projectId)
    const before = seen[projectId]
    if (before) for (const a of mine) if (!before.includes(a.key)) arrived.push({ key: a.key, projectId, appId: a.appId, title: a.title, asks: a.asks, at: now })
    next[projectId] = [...new Set([...(before ?? []), ...mine.map((a) => a.key)])].sort()
  }
  return { seen: next, arrived }
}

export type PendingProposal = { kind: 'mcp' | 'skill'; name: string; at?: number }

/** A proposal has no start time of its own: the time this window first saw it orders it */
export function stampProposals<T extends { name: string }>(prev: readonly { name: string; at?: number }[], next: readonly T[], now: number): (T & { at: number })[] {
  return next.map((p) => ({ ...p, at: prev.find((x) => x.name === p.name)?.at ?? now }))
}

/** `proposal:<kind>:<name>`; no session id has it */
export const PROPOSAL_ID_PREFIX = 'proposal:'

export const isProposalId = (id: string): boolean => id.startsWith(PROPOSAL_ID_PREFIX)

export function pendingProposals(lists: { mcpProposals: readonly { name: string; at?: number }[]; skillProposals: readonly { name: string; at?: number }[] }): PendingProposal[] {
  return [
    ...lists.skillProposals.map((p) => ({ kind: 'skill' as const, name: p.name, at: p.at })),
    ...lists.mcpProposals.map((p) => ({ kind: 'mcp' as const, name: p.name, at: p.at })),
  ]
}

export function proposalCandidates(pending: readonly PendingProposal[]): InboxCandidate[] {
  return pending.map((p) => ({
    id: `${PROPOSAL_ID_PREFIX}${p.kind}:${p.name}`,
    projectId: null,
    name: p.kind === 'mcp' ? `Install MCP server ${p.name}` : `Save skill ${p.name}`,
    state: 'waiting_approval' as const,
    waitingSince: p.at ?? null,
    lastSeq: 0,
    lastReadSeq: 0,
    proposal: p,
  }))
}

export type InboxItem = InboxCandidate & {
  unread: boolean
  waitingMs: number
}

export function isListedWaiting(s: { state: SessionState; interruption?: Interruption | null } & ReadTracked): boolean {
  if (s.interruption?.reason === 'reconnecting') return true
  if (s.interruption && s.state === 'idle') return isUnread(s)
  return s.state === 'waiting_input' ? isUnread(s) : isWaiting(s.state)
}

/** A row with no start time came just now; mail threads are ordered by it too */
export const waitedAt = (s: { waitingSince: number | null }): number => s.waitingSince ?? Number.MAX_SAFE_INTEGER

export function buildInbox(sessions: readonly InboxCandidate[], now: number): InboxItem[] {
  return sessions
    .filter(isListedWaiting)
    .map((s) => ({
      ...s,
      // An idle session stopped by a quit has waited since it stopped
      waitingSince: s.waitingSince ?? s.interruption?.at ?? null,
      unread: isUnread(s),
    }))
    .map((s) => ({ ...s, waitingMs: s.waitingSince == null ? 0 : Math.max(0, now - s.waitingSince) }))
    .sort((a, b) => waitedAt(b) - waitedAt(a) || a.id.localeCompare(b.id))
}

/** Never summed (FR-12: "2 approvals · 3 awaiting response") */
export type WaitingCounts = { approval: number; error: number; input: number }

export function countWaiting(sessions: readonly InboxCandidate[]): WaitingCounts {
  const c: WaitingCounts = { approval: 0, error: 0, input: 0 }
  for (const s of sessions) {
    if (!isListedWaiting(s)) continue
    if (s.state === 'waiting_approval') c.approval++
    // A stopped turn, or a tool reconnecting for too long, counts with the errors (#698)
    else if (s.state === 'error' || s.interruption) c.error++
    else if (s.state === 'waiting_input') c.input++
  }
  return c
}

/** "Go to the next waiting item" (FR-17), in the inbox's order */
export function nextWaitingSession(inbox: readonly InboxItem[], currentId: string | null): string | null {
  const first = inbox[0]
  if (!first) return null
  if (currentId == null) return first.id
  const idx = inbox.findIndex((i) => i.id === currentId)
  if (idx === -1) return first.id
  return (inbox[(idx + 1) % inbox.length] ?? first).id
}

