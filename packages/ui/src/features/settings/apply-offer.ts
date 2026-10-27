import { APP_VERSION, isNewerVersion, type UpdateStatus } from '@cc/protocol/client'
import type { RelaunchCheck, RelaunchPort } from '@cc/platform/ports'

/**
 * What "Apply now" (#352) offers, as pure rules: the update line's button and an agent's request (#665) both read
 * these, so an agent can only ask for what the person could click. Kept apart from the hooks in apply-update.ts so
 * the store can use them without importing the hooks that import it.
 */

/** What the update line says once the host reports `restart_required` */
export type ApplyOffer =
  /** "Apply now": relaunching starts the new build, and the keeper holds everything through it */
  | { kind: 'apply' }
  /** The old wording: this platform cannot relaunch into it, and `reason` says why when known */
  | { kind: 'restart'; reason?: string }
  /**
   * This window already runs the installed version: the relaunch happened, and what is left is
   * the keeper and host switch, which the desktop build bar shows. Saying "restart" here would ask
   * for a relaunch that changes nothing.
   */
  | { kind: 'current' }

/**
 * @param windowVersion the version this window was built from (`APP_VERSION`); the host's
 *   `current` is the host's, which stays the old one until the switch
 * @param relaunch the platform's answer to "would a relaunch start another build", undefined where
 *   the platform cannot relaunch at all, null while it has not answered yet
 */
export function applyOffer(update: UpdateStatus, windowVersion: string, relaunch: RelaunchCheck | null | undefined): ApplyOffer {
  if (update.latest && !isNewerVersion(update.latest, windowVersion)) return { kind: 'current' }
  if (!relaunch?.ready) return { kind: 'restart', ...(relaunch?.reason ? { reason: relaunch.reason } : {}) }
  /*
   * The shell's `ready` says only that the bundle on disk is another build than this window (#665 review): it may be
   * an older one (a backed-up app restored over the installed one). A relaunch is offered only into the version the
   * update line names, read from the bundle itself, and only forward. A local build (`<base>.local.N`) orders by the
   * same rule, as a prerelease identifier.
   */
  const disk = relaunch.version
  if (!disk) return { kind: 'restart', reason: 'The app on disk does not say which version it is, so relaunching could start any build.' }
  if (!isNewerVersion(disk, windowVersion)) {
    return { kind: 'restart', reason: `The app on disk is ${disk}, not newer than this window (${windowVersion}); relaunching would not start the update.` }
  }
  if (update.latest && !sameVersion(disk, update.latest)) {
    return { kind: 'restart', reason: `The app on disk is ${disk}, not the installed ${update.latest}; relaunching would start another build.` }
  }
  return { kind: 'apply' }
}

/** Equal by the comparison's own rule: neither is newer (build metadata and a leading `v` do not count) */
function sameVersion(a: string, b: string): boolean {
  return !isNewerVersion(a, b) && !isNewerVersion(b, a)
}

/** An external install has no host `update_status` event; the window knows its own bundle. */
export function installedUpdate(update: UpdateStatus | null, windowVersion: string, relaunch: RelaunchCheck | null | undefined): UpdateStatus | null {
  if (!relaunch?.ready || !relaunch.version || !isNewerVersion(relaunch.version, windowVersion)) return update
  if (update?.phase === 'restart_required' && update.latest === relaunch.version) return update
  if (update?.phase === 'updating' || update?.phase === 'waiting_for_npm') return update
  return {
    current: update?.current ?? windowVersion,
    auto: update?.auto ?? true,
    autoApply: update?.autoApply ?? false,
    checkedAt: update?.checkedAt ?? null,
    latest: relaunch.version, newer: true, phase: 'restart_required', error: null,
  }
}

export type AgentApplyVerdict = { ready: true; version?: string } | { ready: false; reason: string }

/**
 * Whether this window's "Apply now" could relaunch right now, for an agent's request (#665): the same checks as the
 * button (a relaunch port, an installed build newer than this window, a bundle the shell verified as that build),
 * read fresh from the shell rather than from the update line's last poll. The reasons are written for the agent.
 */
export async function agentApplyVerdict(
  relaunch: RelaunchPort | undefined,
  update: UpdateStatus | null,
  windowVersion: string = APP_VERSION,
): Promise<AgentApplyVerdict> {
  if (!relaunch) {
    return { ready: false, reason: 'A window that cannot relaunch itself answered (a browser window, or a desktop app whose agent host is not held by the background keeper).' }
  }
  const check = await relaunch.check().catch((e: unknown): RelaunchCheck => ({ ready: false, reason: String(e) }))
  const u = installedUpdate(update, windowVersion, check)
  if (u?.phase === 'updating' || u?.phase === 'waiting_for_npm') {
    return { ready: false, reason: `The install of ${u.latest ?? 'the new version'} is still running; apply once it has finished.` }
  }
  if (!u || u.phase !== 'restart_required') {
    return { ready: false, reason: 'No update is installed to apply. Install one first (update_centralu with action install).' }
  }
  const offer = applyOffer(u, windowVersion, check)
  if (offer.kind === 'current') {
    return { ready: false, reason: `The window already runs ${u.latest ?? windowVersion}; the agent host switches to it from the window's build bar.` }
  }
  if (offer.kind === 'restart') {
    return { ready: false, reason: `This window cannot relaunch into ${u.latest ?? 'the installed build'}${offer.reason ? `: ${offer.reason}` : ''}. Centralu has to be quit and opened again.` }
  }
  const version = check.version ?? u.latest
  return { ready: true, ...(version ? { version } : {}) }
}
