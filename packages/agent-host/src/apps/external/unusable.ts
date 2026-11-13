import type { ExternalAppInfo } from '@cc/protocol'

/*
 * What keeps an app from being given or run, read from its listing (`ExternalApps.list`) by every path that decides it:
 * a session's apps here, `attach_app`, and a linked host's calls. Apart from runtime.ts, which only fills in the listing.
 */

const UNUSABLE_STATUS = new Set<ExternalAppInfo['status']>(['invalid', 'untrusted', 'unconfirmed', 'failed'])

/**
 * Why a listed app is given to no session, here or on a linked host (decision 4), or null when it may be: an invalid
 * manifest, an untrusted project, an imported app not turned on yet (M4 E-3), halted after repeated failures, or turned
 * off on this computer (#1938, `off`). The one rule for every list a session is given; the runtime's `blocker` refuses
 * each call again (in case the name lingers in a Codex thread).
 */
export function unusableAs(a: Pick<ExternalAppInfo, 'status' | 'off'>): string | null {
  if (a.off === true) return 'off'
  return UNUSABLE_STATUS.has(a.status) ? a.status : null
}

/**
 * What an agent is told about an app turned off on this computer (#1938, docs/plans/remote-hub.md §13.7), for a call
 * and for `attach_app` alike: one wording. `app` as the agent names it
 */
export const offRefusal = (app: string): string => `${app} is turned off on this computer, so nothing ran. Only the person can turn it on (its project's Settings → Apps).`
