import { CENTRALU_APPLY, CENTRALU_APPLY_QUESTION } from '@cc/protocol'
import type { UpdateApplyBroker } from '../update-apply.js'
import type { UpdateService } from '../updates.js'
import type { DelegationHost } from './delegation-flow.js'
import type { RoutedCardsHost } from './routed-cards.js'

/**
 * What an agent's update_centralu reaches of the session manager (#428), typed as the manager declares each member.
 * The manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type UpdatesAskedHost = Pick<DelegationHost, 'askHost' | 'meta'> & Pick<RoutedCardsHost, 'apps' | 'toolProfileOf'>

/**
 * An agent's update_centralu (#665): check and install through the same service the window calls, and apply through a
 * window's "Apply now", each behind the calling session's preset and the person's card. What a session was allowed
 * lasts for that session on this host. Moved out of the session manager as it was (#428); what it reaches of the
 * manager is `UpdatesAskedHost`.
 */
export class UpdatesAsked {
  constructor(private readonly host: UpdatesAskedHost) {}

  updates: UpdateService | null = null
  /** Sessions allowed to update once per host; an "always" answer adds this session only. */
  readonly updateConsents = new Set<string>()
  /** Asking a window to apply the installed update (#665); null on a host with no windows to ask (tests) */
  updateApply: UpdateApplyBroker | null = null
  /**
   * Whether the person's Automatic updates are on and nothing but the asking session runs (#1509; the host's `updateAtRest`,
   * main.ts). Null on a host that cannot tell (tests): then every apply is carded
   */
  updateAtRest: ((besidesSessionId: string) => boolean) | null = null
  /**
   * The installed version whose card-free relaunch failed (#1509): for it the card comes back, so an agent cannot retry a
   * relaunch that does not work in a loop with no one asked. Host-wide, as a failure is the host's, not one session's
   */
  private uncardedFailedFor: string | null = null
  /** Sessions whose "always" covers applying (#665), kept apart from check and install: a relaunch is the person's window */
  readonly updateApplyConsents = new Set<string>()

  /** Update grants last only for the calling session on this host; they never change automatic application. */
  async updateCentraluAsked(
    sessionId: string,
    action: 'check' | 'install' | 'apply',
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; status?: import('@cc/protocol').UpdateStatus; relaunched?: { version?: string } }> {
    if (action === 'apply') return this.applyUpdateAsked(sessionId, signal)
    const updates = this.updates
    if (!updates) return { ok: false, error: 'Update checks are unavailable' }
    if (this.host.toolProfileOf(sessionId) === 'reader' && !this.updateConsents.has(sessionId)) {
      const decision = await this.host.askHost(sessionId, { kind: 'centralu_update', action })
      if (decision === 'always') this.updateConsents.add(sessionId)
      else if (decision !== 'allow') return { ok: false, error: 'The person did not allow this Centralu update. Do not ask again unless they tell you to.' }
    }
    return { ok: true, status: action === 'check' ? await updates.check(true) : await updates.apply() }
  }

  /**
   * `update_centralu` action "apply" (#665): a window relaunches into the installed build, as its "Apply now" does.
   *
   * By the caller's own preset, read now (as every boundary of #606): `auto` applies at once, `normal` raises a card in
   * the caller (after a window said it is ready, so "nothing installed" never asks), `safe` is refused, as is an agent an
   * app started. "Always" on the card covers applying for this session only, apart from check and install. The window
   * still makes every check its button makes (update-apply.ts), so an agent can only ask for what the person could click.
   *
   * No card either when the person's Automatic updates are on and nothing else runs (#1509, owner 2026-10-24): the window's own
   * auto-apply would relaunch at that moment, so the card guards nothing. Judged in the consent step, after a window said
   * it is ready, and again after the windows were asked a second time, right before the relaunch; the window also waits out
   * someone typing (`update_apply_go.unasked`). `safe` is refused before that, as it was.
   */
  private async applyUpdateAsked(sessionId: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string; relaunched?: { version?: string } }> {
    const broker = this.updateApply
    if (!broker) return { ok: false, error: 'Applying updates is unavailable on this host' }
    const m = this.host.meta.get(sessionId)
    if (!m) return { ok: false, error: 'The calling session is gone' }
    if (this.host.apps.isAppAgentSession(m)) return { ok: false, error: 'An agent an app started cannot apply Centralu updates.' }
    if (m.permissionPreset === 'safe') {
      return {
        ok: false,
        error: "This session's preset is safe, which cannot relaunch Centralu. Tell the person the update is ready to apply from the update line; do not ask again unless they tell you to.",
      }
    }
    // Whether the consent went with no card because the host is at rest (#1509); judged again right before the relaunch
    let uncarded = false
    // Whether a go was sent with no card, and for which installed version
    let wentUncarded = false
    const installed = this.updates?.current().latest ?? ''
    const outcome = await broker.apply(async () => {
      if (this.updateApplyConsents.has(sessionId)) return null
      if (this.uncardedFailedFor !== installed && this.updateAtRest?.(sessionId) === true) {
        uncarded = true
        return null
      }
      // As `other` with its whole question as the text: a released window drops a detail it cannot parse (#665 review)
      const decision = await this.host.askHost(sessionId, { kind: 'other', raw: CENTRALU_APPLY_QUESTION, about: CENTRALU_APPLY }, signal)
      if (decision === 'always') this.updateApplyConsents.add(sessionId)
      else if (decision === null) return 'The question to the person was withdrawn before they answered, so nothing was relaunched.'
      else if (decision !== 'allow') return 'The person did not allow this session to apply the Centralu update. Do not ask again unless they tell you to.'
      return null
    }, () => {
      if (!uncarded) return undefined
      if (this.updateAtRest?.(sessionId) !== true) return 'Something started running while the windows were asked, so nothing was relaunched. Call again to be asked.'
      wentUncarded = true
      return null
    })
    if (!outcome.ok) {
      // A relaunch sent with no card that did not happen: the next apply for this version asks the person
      if (wentUncarded) this.uncardedFailedFor = installed
      return { ok: false, error: outcome.error }
    }
    console.error(`[updates] session ${sessionId} applied the installed update: a window is relaunching${outcome.version ? ` into ${outcome.version}` : ''}`)
    return { ok: true, relaunched: outcome.version ? { version: outcome.version } : {} }
  }
}
