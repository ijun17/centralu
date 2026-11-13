import type { LinkedAppNoticeParams } from '@cc/protocol'
import type { ExternalApps } from '../apps/external/runtime.js'
import { startingHub } from '../sessions/hub-preset.js'
import { LinkedAppCalls } from './linked-app-calls.js'
import type { AppsPeers } from './linked-apps.js'
import type { LinkedHubs } from './linked-hubs.js'
import { qualify, splitQualified } from './machine-ids.js'

/**
 * A project's app used from another machine (#1938, docs/plans/remote-hub.md §13), wired one way for main.ts and the
 * tests: who may reach what on each side, the linked hosts a session here uses apps of, and where an app's notice to a
 * session of another host goes. A host may be a hub and a machine at once.
 */

/** A linked machine as the hub's links hold it */
type Machine = { id: string; name: string; reachable: boolean; answersApps: boolean; call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> }
type Machines = { get(id: string): Machine | undefined; all(): Machine[] }
type Runtime = Pick<ExternalApps, 'list' | 'knownTools' | 'tools' | 'call' | 'runs'>

/**
 * What a hub answers a machine (`hub.apps`, `hub.appCall`): the apps of the project a hub session's started agent works
 * for (§13.5), found from the hub's own record of it, never from what the call says. Any other session of the machine is
 * refused until the owner's card for it lands (§13.13 question 1, PR 3)
 */
export function hubAppCalls(rt: Runtime, o: { selfName: () => string; parentProject: (qualifiedSessionId: string) => string | null; projectName: (id: string) => string }): LinkedAppCalls {
  return new LinkedAppCalls({
    rt,
    reach: (from, session, app) => app.projectId !== null && o.parentProject(qualify(from.id, session)) === app.projectId,
    refusal: (from, session) =>
      o.parentProject(qualify(from.id, session)) === null ? `Only the agents ${o.selfName()}'s sessions started on ${from.name} use ${o.selfName()}'s apps; other sessions there cannot yet. Nothing ran.` : null,
    projectName: o.projectName,
  })
}

/**
 * What a machine answers its hub (`host.apps`, `host.appCall`): what a session of another project here may attach (the
 * "May attach" table of domain-model.md): a shared app, or a trusted project's root app. Whether the person allowed that
 * session's project to use it is the hub's card (§13.4)
 */
export function machineAppCalls(rt: Runtime, o: { projectName: (id: string) => string }): LinkedAppCalls {
  return new LinkedAppCalls({ rt, reach: (_from, _session, app) => app.shared === true || app.root === true, refusal: () => null, projectName: o.projectName })
}

/**
 * The linked hosts a session here uses apps of (`LinkedApps`): on a hub every machine it links; on a machine the hub that
 * started the session (`startingHub`), and only that one, so a started agent never reaches another hub's apps. Whether
 * that hub gives it apps is `LinkedApps.givingHub`'s to say
 */
export function appsPeers(o: { machines?: Machines; hubs?: Pick<LinkedHubs, 'appsPeer'>; settings?: { appSetting(key: string): string | null } }): AppsPeers {
  return {
    machines: () =>
      (o.machines?.all() ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        reachable: m.reachable,
        answers: m.answersApps,
        gives: false,
        call: (method, params, timeoutMs) => m.call(`host.${method}`, params, timeoutMs),
      })),
    startedBy: (sessionId) => {
      const hub = o.settings ? startingHub(o.settings, sessionId) : null
      return hub ? { hub, link: o.hubs?.appsPeer(hub.id) } : null
    },
  }
}

/**
 * Where an app's notice to a session of a linked host goes (`uses.notices`, §13.3): the session's id here is qualified by
 * its host, as the run recorded it, and the notice is passed on as `host.appNotice` to a machine or `hub.appNotice` to a
 * hub. null for a session of this host's own, which the caller delivers itself
 */
export function linkedNotices(o: { machines?: Machines; hubs?: Pick<LinkedHubs, 'appsPeer'> }): (sessionId: string, text: string, app: { appId: string; projectId: string | null; name: string }) => Promise<void> | null {
  return (sessionId, text, app) => {
    const split = splitQualified(sessionId)
    if (!split || app.projectId === null) return null
    const params: LinkedAppNoticeParams = { session: split.id, projectId: app.projectId, appId: app.appId, name: app.name, text }
    const machine = o.machines?.get(split.machine)
    if (machine) return machine.call('host.appNotice', params).then(() => undefined)
    const hub = o.hubs?.appsPeer(split.machine)
    if (hub) return hub.call('appNotice', params, 30_000).then(() => undefined)
    return null
  }
}
