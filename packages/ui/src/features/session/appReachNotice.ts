import type { AppReach } from '@cc/protocol'

type Unreachable = Extract<AppReach, { reachable: false }>

/**
 * The quiet line under a link dropped from an app whose tools this session cannot use (#308).
 *
 * The link is in the message either way, and the agent can still open it. What the line adds is the
 * one thing the person cannot see from the link: that the agent will not have the app's tools, and
 * what would give them (apps.md §9.1 for who gets which apps). `app` is the app's name, `project` the
 * name of the project it belongs to (null for one of the person's own apps).
 */
export function appReachNotice(r: Unreachable, app: string, project: string | null): string {
  const cannot = `This session can't use ${app}'s tools`
  switch (r.reason) {
    case 'other-project':
      return project === null
        ? `${cannot}: it is one of your apps, which only the orchestrator can use.`
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
