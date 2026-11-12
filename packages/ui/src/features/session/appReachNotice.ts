import type { AppReach, ExternalAppInfo } from '@cc/protocol/client'
import { appTitleOf, machineNameOf } from '../../store/names.js'
import { isApp } from '../../store/appKeys.js'
import type { AppLinkDrop } from '../app-frame/dragRelay.js'

type Unreachable = Extract<AppReach, { reachable: false }>

/**
 * The name the quiet line gives the app a link was dragged from: the app of the list that the drop names, and a linked
 * machine's user-folder app is not this computer's of the same id (#82), so the machine is part of the match.
 */
export function droppedAppTitle(apps: readonly ExternalAppInfo[], from: AppLinkDrop['from']): string {
  const app = apps.find((a) => isApp(a, from.projectId, from.appId, from.machine))
  return appTitleOf({ name: app?.name, appId: from.appId })
}

/**
 * The quiet line for a link dragged out of a user-folder app that runs on another computer than the session (#82), or null when
 * both are on one. The window knows both machines, so it decides, and asks no one: a user-folder app has no project to say where it
 * is, and a host asked about it would check the same-named app of its own machine. `machines`: the linked machines, by id. A
 * project's app is not asked about here: its project id names its machine already.
 */
export function otherMachineNotice(
  from: AppLinkDrop['from'],
  sessionMachine: string | null | undefined,
  apps: readonly ExternalAppInfo[],
  machines: Readonly<Record<string, { name: string }>>,
): string | null {
  const appMachine = from.machine ?? null
  if (from.projectId !== null || appMachine === (sessionMachine ?? null)) return null
  return `${droppedAppTitle(apps, from)} runs on ${appMachine === null ? 'this computer' : machineNameOf(machines, appMachine)}, and this session is on another computer.`
}

/**
 * What the composer does with a link dragged out of an app (#308): `tell` a line of its own when the app is a user-folder app on
 * another computer than the session's, asking no one; otherwise `ask` the host whether the session can use the app's tools
 * (`apps.reach`). The one decision, kept out of the component so a test holds it.
 */
export type AppDropVerdict = { kind: 'tell'; text: string; reason: 'other-machine' } | { kind: 'ask' }

export function appDropVerdict(
  from: AppLinkDrop['from'],
  sessionMachine: string | null | undefined,
  apps: readonly ExternalAppInfo[],
  machines: Readonly<Record<string, { name: string }>>,
): AppDropVerdict {
  const text = otherMachineNotice(from, sessionMachine, apps, machines)
  return text === null ? { kind: 'ask' } : { kind: 'tell', text, reason: 'other-machine' }
}

/**
 * The quiet line under a link dropped from an app whose tools this session cannot use (#308).
 *
 * The link is in the message either way, and the agent can still open it. What the line adds is the
 * one thing the person cannot see from the link: that the agent will not have the app's tools, and
 * what would give them (apps/attaching.md "Which session gets which apps" for who gets which apps). `app` is the app's name, `project` the
 * name of the project it belongs to (null for one of the person's own apps).
 */
export function appReachNotice(r: Unreachable, app: string, project: string | null): string {
  const cannot = `This session can't use ${app}'s tools`
  switch (r.reason) {
    case 'other-project':
      return project === null
        ? `${cannot}: it is one of your apps, which only the Assistant can use.`
        : `${cannot}: the app belongs to ${project}. Ask in a session of ${project} to use them.`
    case 'untrusted':
      return `${cannot}: ${project ?? 'its project'} is not trusted. Trust the project to attach its apps.`
    case 'app-unusable':
      if (r.status === 'failed') return `${cannot}: the app stopped after repeated failures. Restart it from its view.`
      if (r.status === 'unconfirmed') return `${cannot}: the app is not turned on yet. Review it and turn it on first.`
      return `${cannot}: the app's manifest is not valid. Once it is fixed, the app attaches again.`
    case 'restart':
      return `${cannot} yet: its Codex thread started before the app was attached. Restart the session to attach it.`
    case 'bridge-failed':
      return `${cannot}: the app's bridge did not start in this session. Restart the session to try again.`
    case 'unavailable':
      return `${cannot}: the app is not available.`
  }
}
