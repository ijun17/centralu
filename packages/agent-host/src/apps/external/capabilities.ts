import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppRef } from './ref.js'
import { canonicalJson } from './runs.js'

/**
 * The data an app can read from the host — a **closed list** (M4 D-3, this is where the "capability
 * model" from #97's third item gets worked out on the external-app side).
 *
 * An app lists what it wants to use from this list under `uses.host` in its manifest. Anything not
 * listed is refused (default is denial). A name outside the list is not a capability at all —
 * opening a single "read host data" tool and letting the request's text decide what it gets back
 * would mean the app's request, not the code, decides what leaks. So this file decides here, by
 * name, what and how much each capability gives, and adding a name means editing this file.
 *
 * All of these are **read-only**. A capability that changes the host (sending a message into a
 * session, creating a session) does not belong on this list — that kind of thing has its own path
 * of asking the person's agent (`run_agent`), and that path follows the approval rules in the
 * session the person watches.
 *
 *   sessions.list  a summary of sessions — name, state, tool, kind, timestamp. Does not carry the
 *                  conversation (not even a preview). The name is the same name shown in the
 *                  sidebar: a session the person never named gets the first 40 characters of the
 *                  first message as its name, so that fragment is what leaves — if the name is not
 *                  in the list, the app cannot use it, and nothing further leaks. A project app gets
 *                  that project's sessions; a user-folder app gets all sessions (a user-folder app
 *                  belongs to the orchestrator — decision 4)
 *   git.status     the project's branch and its list of changed files. Project apps only — a
 *                  user-folder app has no project to pick
 */
export const HOST_CAPABILITIES = ['sessions.list', 'git.status'] as const
export const HostCapability = z.enum(HOST_CAPABILITIES)
export type HostCapability = z.infer<typeof HostCapability>

export function isHostCapability(name: string): name is HostCapability {
  return HostCapability.safeParse(name).success
}

/** The wording for a person to read — used by capability approval's (D-4) question and by refusal reasons. The wording differs by scope. */
export function hostCapabilityText(name: HostCapability, scope: 'project' | 'user'): string {
  switch (name) {
    case 'sessions.list':
      return scope === 'project'
        ? "read the list of this project's sessions (the names you see in the sidebar and their states, not the conversations)"
        : 'read the list of all your sessions (the names you see in the sidebar and their states, not the conversations)'
    case 'git.status':
      return "read this project's git branch and changed files"
  }
}

/**
 * One capability an app wants to use (M4 D-4) — the unit that is asked about and whose answer is
 * remembered.
 *
 *   agent  asks for an agent — per tool (allowing Claude does not also allow Codex)
 *   app    calls another app — per app called. An app is (scope, id), so the scope is included too:
 *          if an app with the same id is newly created in a project, the call target has changed
 *          (resolveCallTarget), and what the person allowed was not that app
 *   host   reads host data — per name
 */
export type Capability =
  | { kind: 'agent'; tool: string }
  | { kind: 'app'; target: AppRef }
  | { kind: 'host'; name: HostCapability }

/** The memory key — points at one capability within one app */
export function capabilityKey(c: Capability): string {
  switch (c.kind) {
    case 'agent':
      return `agent:${c.tool}`
    case 'app':
      return `app:${c.target.projectId ?? '_user'}/${c.target.appId}`
    case 'host':
      return `host:${c.name}`
  }
}

/**
 * The fingerprint of the manifest's declaration (`uses`) — an answer is remembered together with
 * this fingerprint, and if the fingerprint changes, it is asked again (plan D-4). This looks at the
 * whole declaration: whichever field changed, the app's builder has restated what the app uses, and
 * the person has a reason to look again too. The same declaration produces the same fingerprint
 * regardless of key order (`canonicalJson`).
 */
export function usesStamp(uses: unknown): string {
  return createHash('sha256').update(canonicalJson(uses ?? {})).digest('hex')
}

/** One remembered answer */
export type CapabilityDecision = {
  capability: string
  /** The wording shown to the person when asked — shown again verbatim in the list */
  text: string
  decision: 'allow' | 'deny'
  /** The declaration fingerprint at the time of the answer (`usesStamp`) */
  stamp: string
  decidedAt: number
}

/**
 * Where answers are stored — the runtime only declares the shape, and the host fills it in with the
 * store (the same inversion as `RunLedger`, main.ts). Without one, it falls back to memory
 * (`memoryCapabilityBook`) — this keeps the promise of asking once per host lifetime.
 */
export type CapabilityBook = {
  get(app: AppRef, capability: string): CapabilityDecision | null
  put(app: AppRef, d: CapabilityDecision): void
  forget(app: AppRef, capability: string): void
  list(app: AppRef): CapabilityDecision[]
}

export function memoryCapabilityBook(): CapabilityBook {
  const key = (app: AppRef) => `${app.projectId ?? '_user'}/${app.appId}`
  const rows = new Map<string, Map<string, CapabilityDecision>>()
  return {
    get: (app, capability) => rows.get(key(app))?.get(capability) ?? null,
    put: (app, d) => {
      const m = rows.get(key(app)) ?? new Map<string, CapabilityDecision>()
      m.set(d.capability, { ...d })
      rows.set(key(app), m)
    },
    forget: (app, capability) => void rows.get(key(app))?.delete(capability),
    list: (app) => [...(rows.get(key(app))?.values() ?? [])].map((d) => ({ ...d })),
  }
}
