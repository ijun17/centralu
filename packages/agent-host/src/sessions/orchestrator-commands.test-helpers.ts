import { expect } from 'vitest'
import { eventually } from '../../../../tooling/test-timing.js'
import type { SessionManager } from './manager.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'

/**
 * The calls the `*-commands.test.ts` files share: the orchestrator runs a command through `centralu_run`, the card it
 * raises (the one whose `about` is given) stands in its session until the person answers
 */
export function commandRig(mgr: () => SessionManager, about: string) {
  /** The card standing in a session, if one is */
  function card(sessionId: string) {
    const pending = mgr().listSessions().find((s) => s.id === sessionId)?.pendingApproval
    const d = pending?.detail
    return d?.kind === 'other' && d.about === about ? { requestId: pending!.requestId, text: d.raw } : undefined
  }

  function run(orcId: string, command: string, args: Record<string, unknown> = {}) {
    return mgr().runOrchestratorTool(orcId, 'centralu_run', { command, args })
  }

  /** Runs a command whose card the person answers with `decision`; the card's question and the answer */
  async function answered(orcId: string, command: string, args: Record<string, unknown>, decision: 'allow' | 'deny' | 'always', whileStanding?: () => Promise<void>) {
    const call = run(orcId, command, args)
    await eventually(() => !!card(orcId))
    const question = card(orcId)!.text
    await whileStanding?.()
    mgr().respondApproval(orcId, card(orcId)!.requestId, decision)
    return { question, r: await call }
  }

  return { card, run, answered }
}

/** Only the orchestrator runs these, as rare commands in the default tier; no other seat in any tier */
export function expectOnlyOrchestratorRuns(commands: readonly string[]) {
  for (const name of commands) {
    expect(commandsFor('orchestrator', 'commands')).toContain(name)
    for (const tier of RARE_TIERS) {
      for (const profile of ['scoped', 'builder', 'reader'] as const) {
        expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
      }
    }
  }
}
