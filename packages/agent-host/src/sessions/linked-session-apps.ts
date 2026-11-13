import type { ExternalAppInfo } from '@cc/protocol'
import type { AppToolResult } from '../adapters/contract.js'
import type { AppRef } from '../apps/external/runtime.js'
import { LinkedApps } from '../links/linked-apps.js'
import { failure, toResult } from './app-results.js'

/*
 * The cross-machine part of a session's apps (#1938, docs/plans/remote-hub.md §13.5), apart from session-apps.ts: what the
 * hub that started a session here changes in the apps decision 4 gives it. The rule itself is `LinkedApps.givingHub`.
 */

/** An app a session is given, the ref its name is kept under (`AppNameBook`), and why it is not run, when it is not */
export type GivenApp = { app: ExternalAppInfo; nameAs: AppRef; withheld?: string }

/**
 * The apps decision 4 gives a session (`given`), with the hub that started it applied. For a session whose hub gives it
 * apps (`givingHub`), every app of its own project here is its checkout's copy of that hub's, and none of them runs for it,
 * whatever the hub lists: the hub's app of the same id takes the copy's place under the copy's name (the one the session's
 * agent may know it by already, from before the hub listed or from an earlier build), and a copy the hub does not list
 * now keeps its name and answers why nothing ran. Every other session is given its apps as they are.
 */
export function standIns(linked: LinkedApps | undefined, session: { id: string; projectId: string | null }, given: readonly ExternalAppInfo[]): GivenApp[] {
  const hub = linked?.givingHub(session.id)
  if (!linked || !hub) return given.map((app) => ({ app, nameAs: app }))
  const copy = (a: ExternalAppInfo) => isCopy(session, a)
  // Only the giving hub's apps are given from another host: a machine's are attached, never given
  const there = (appId: string) => given.find((a) => LinkedApps.owns(a) && a.appId === appId)
  const out: GivenApp[] = []
  for (const a of given) {
    if (copy(a)) {
      const app = there(a.appId)
      out.push(app ? { app, nameAs: a } : { app: a, nameAs: a, withheld: linked.withheldWhy(hub, a.appId) })
    } else if (!LinkedApps.owns(a) || !given.some((c) => copy(c) && c.appId === a.appId)) out.push({ app: a, nameAs: a })
  }
  return out
}

/** An app of the session's own project on this host: for a session its hub gives apps to, the checkout's copy of one */
const isCopy = (session: { projectId: string | null }, a: Pick<ExternalAppInfo, 'projectId'>) => !LinkedApps.owns(a) && a.projectId !== null && a.projectId === session.projectId

/** Whether this app here is a checkout's copy the session never runs (`standIns`): its own project's, its hub giving it apps */
export function runsNotHere(linked: LinkedApps | undefined, session: { id: string; projectId: string | null }, app: Pick<ExternalAppInfo, 'projectId'>): boolean {
  return isCopy(session, app) && !!linked?.givingHub(session.id)
}

/** `run_status` of a run on a linked host (#1938), answered there from what it kept of this session's runs */
export async function linkedRunStatus(linked: LinkedApps, sessionId: string, ref: AppRef, runId: string): Promise<AppToolResult> {
  const o = await linked.runStatus(sessionId, ref, runId)
  if (o === 'running') {
    return { content: [{ type: 'text', text: `Run ${runId} is still running. Check again a little later.` }], isError: false, structuredContent: { runId, status: 'running' } }
  }
  if (o.status === 'rejected' && !o.result) return failure(o.error ?? `Unknown run id: ${runId}`)
  const done = toResult(o)
  return {
    content: [{ type: 'text', text: `Run ${runId} has finished (${o.status}). Its result:` }, ...done.content],
    isError: done.isError,
    structuredContent: { runId, status: o.status, ...(done.structuredContent ? { result: done.structuredContent } : {}) },
  }
}
