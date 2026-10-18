import type { Interruption, SessionState } from '@cc/protocol'
import { URGENCY, isWaiting } from '../session/state-machine.js'
import { isUnread, type ReadTracked } from '../unread/unread.js'

/**
 * The inbox is derived state (docs/state-management.md §3). It is never stored.
 * Order: urgency → unread → when the wait started, ascending (the longest wait first).
 *
 * **What is listed** (#669): approvals and errors while the session is in that state, and a
 * `waiting_input` session only while it is unread. A finished turn the person has already read
 * (or marked Done) needs nothing more, so it leaves the list; a new answer (a new `lastSeq`)
 * makes it unread again and it returns. The list, the counters, the sidebar's folded summary and
 * "next waiting" all ask `isListedWaiting`, so they cannot disagree.
 *
 * **A stopped turn is listed too** (#698): a session whose last turn the network, a quit or its tool cut short rests in
 * a state that says nothing of it (`idle` after a quit, `waiting_input` after an interrupt). It is listed like a
 * finished turn, while unread, with the urgency of an error; the line Centralu writes for a quit makes it unread.
 * A tool reconnecting for too long is listed while it lasts, though the session is still working.
 *
 * **A pending orchestrator proposal (an MCP server or a skill, #703) is listed like an approval.** It is not a session
 * state: the orchestrator went on talking, but a card waits for the person's answer. `proposalCandidates` turns the
 * pending proposals into candidates in the `waiting_approval` state, so every function below counts, orders and cycles
 * through them without a second rule.
 */

export type InboxCandidate = {
  id: string
  /** An orchestrator has no project */
  projectId: string | null
  name: string
  state: SessionState
  waitingSince: number | null
  lastSeq: number
  lastReadSeq: number
  preview?: string
  interruption?: Interruption | null
  /** The wait is a question the agent asked, which the person answers rather than allows (listed as an approval is) */
  asking?: boolean
  /** Set on a pending orchestrator proposal (#703): this row is the proposal, not a session, and `id` is not a session id */
  proposal?: PendingProposal
  /** Set on an app a trusted project gained (#1141): this row is the notice, not a session, and `id` is not a session id */
  arrival?: AppArrival
}

/**
 * An app a project already trusted gained since the window last looked (#1141), say a manifest a `git pull` brought: it
 * is trusted with the project (owner), so the inbox says so once, with what it declares it may ask for (`asks`, plain
 * words, empty for nothing beyond its own tools). Dismissed by opening it or with Done.
 */
export type AppArrival = { key: string; projectId: string; appId: string; title: string; asks: string[] }

/** The id prefix of a row that stands for an app arrival: `app-arrival:<app key>`. No session id has it. */
export const APP_ARRIVAL_ID_PREFIX = 'app-arrival:'

export const isAppArrivalId = (id: string): boolean => id.startsWith(APP_ARRIVAL_ID_PREFIX)

/** The arrivals as inbox candidates: unread and waiting on the person, like a finished turn, so Done clears them */
export function appArrivalCandidates(arrivals: readonly AppArrival[]): InboxCandidate[] {
  return arrivals.map((a) => ({
    id: `${APP_ARRIVAL_ID_PREFIX}${a.key}`,
    projectId: a.projectId,
    name: `New app: ${a.title}`,
    state: 'waiting_input' as const,
    waitingSince: null,
    lastSeq: 1,
    lastReadSeq: 0,
    arrival: a,
  }))
}

/**
 * Which apps of trusted projects are new since the window last looked (#1141), and what it has seen now.
 *
 * `seen` holds, per trusted project the window has looked at, the keys of its apps then. A project not in it yet is
 * looked at for the first time (just registered, just trusted, or a window from before this): its apps are taken as
 * seen without a notice, since the person trusted or made it with them there. An app of a project in it whose key it
 * does not hold is new. An untrusted project is dropped, so trusting it again starts afresh: its trust card lists its
 * apps then.
 */
export function noteAppArrivals(
  apps: readonly { key: string; projectId: string | null; appId: string; title: string; asks: string[] }[],
  trusted: ReadonlySet<string>,
  seen: Readonly<Record<string, readonly string[]>>,
): { seen: Record<string, string[]>; arrived: AppArrival[] } {
  const next: Record<string, string[]> = {}
  const arrived: AppArrival[] = []
  for (const projectId of trusted) {
    const mine = apps.filter((a) => a.projectId === projectId)
    const before = seen[projectId]
    if (before) for (const a of mine) if (!before.includes(a.key)) arrived.push({ key: a.key, projectId, appId: a.appId, title: a.title, asks: a.asks })
    next[projectId] = [...new Set([...(before ?? []), ...mine.map((a) => a.key)])].sort()
  }
  return { seen: next, arrived }
}

/** An orchestrator proposal waiting for the person's answer, by the name it was proposed under */
export type PendingProposal = { kind: 'mcp' | 'skill'; name: string }

/** The id prefix of a row that stands for a pending proposal: `proposal:<kind>:<name>`. No session id has it. */
export const PROPOSAL_ID_PREFIX = 'proposal:'

export const isProposalId = (id: string): boolean => id.startsWith(PROPOSAL_ID_PREFIX)

/** The pending proposals of the two lists the host keeps, skills, then MCP servers */
export function pendingProposals(lists: { mcpProposals: readonly { name: string }[]; skillProposals: readonly { name: string }[] }): PendingProposal[] {
  return [
    ...lists.skillProposals.map((p) => ({ kind: 'skill' as const, name: p.name })),
    ...lists.mcpProposals.map((p) => ({ kind: 'mcp' as const, name: p.name })),
  ]
}

/**
 * The pending proposals as inbox candidates (#703). They wait in the `waiting_approval` state. A proposal carries no start
 * time, so it has no `waitingSince` and sorts after the approvals that do.
 */
export function proposalCandidates(pending: readonly PendingProposal[]): InboxCandidate[] {
  return pending.map((p) => ({
    id: `${PROPOSAL_ID_PREFIX}${p.kind}:${p.name}`,
    projectId: null,
    name: p.kind === 'mcp' ? `Install MCP server ${p.name}` : `Save skill ${p.name}`,
    state: 'waiting_approval' as const,
    waitingSince: null,
    lastSeq: 0,
    lastReadSeq: 0,
    proposal: p,
  }))
}

export type InboxItem = InboxCandidate & {
  unread: boolean
  urgency: number
  waitingMs: number
}

/** Does this session belong in the inbox and its counters? */
export function isListedWaiting(s: { state: SessionState; interruption?: Interruption | null } & ReadTracked): boolean {
  if (s.interruption?.reason === 'reconnecting') return true
  if (s.interruption && s.state === 'idle') return isUnread(s)
  return s.state === 'waiting_input' ? isUnread(s) : isWaiting(s.state)
}

/** A stopped turn waits on the person as an error does (#698): only an approval blocks the agent more */
export function urgencyOf(s: { state: SessionState; interruption?: Interruption | null }): number {
  return s.interruption ? Math.min(URGENCY[s.state], URGENCY.error) : URGENCY[s.state]
}

export function buildInbox(sessions: readonly InboxCandidate[], now: number): InboxItem[] {
  return sessions
    .filter(isListedWaiting)
    .map((s) => ({
      ...s,
      // An idle session stopped by a quit has no wait of its own; it has waited since it stopped
      waitingSince: s.waitingSince ?? s.interruption?.at ?? null,
      unread: isUnread(s),
      urgency: urgencyOf(s),
    }))
    .map((s) => ({ ...s, waitingMs: s.waitingSince == null ? 0 : Math.max(0, now - s.waitingSince) }))
    .sort(
      (a, b) =>
        a.urgency - b.urgency ||
        Number(b.unread) - Number(a.unread) ||
        (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity) ||
        a.id.localeCompare(b.id),
    )
}

/** The global counters — never summed (FR-12: "2 approvals · 3 awaiting response") */
export type WaitingCounts = { approval: number; error: number; input: number }

export function countWaiting(sessions: readonly InboxCandidate[]): WaitingCounts {
  const c: WaitingCounts = { approval: 0, error: 0, input: 0 }
  for (const s of sessions) {
    if (!isListedWaiting(s)) continue
    if (s.state === 'waiting_approval') c.approval++
    // A stopped turn, or a tool reconnecting for too long, counts with the errors (#698), as `urgencyOf` orders it
    else if (s.state === 'error' || s.interruption) c.error++
    else if (s.state === 'waiting_input') c.input++
  }
  return c
}

/**
 * "Go to the next waiting item" (FR-17). Cycles to the item after the current session.
 * It follows the inbox order exactly, so the order is approval → error → awaiting response.
 */
export function nextWaitingSession(inbox: readonly InboxItem[], currentId: string | null): string | null {
  if (inbox.length === 0) return null
  if (currentId == null) return inbox[0]!.id
  const idx = inbox.findIndex((i) => i.id === currentId)
  if (idx === -1) return inbox[0]!.id
  return inbox[(idx + 1) % inbox.length]!.id
}

