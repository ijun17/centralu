import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import type { CreateSessionOpts } from '../contract.js'
import { appToolOf, isOrchestratorTool } from './permissions.js'

/**
 * How long the person may take over a card before the CLI gives up on the hook. A card waits for a person; the CLI's own default would end the
 * wait early. Measured (scripts/probe-pretooluse-hook.mts): with this set, a 75 s wait for the answer is honoured and a denied command does not run
 */
const HOOK_TIMEOUT_SECONDS = 3600

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The person's card for every step of the CLI's own in a turn that a session's request is (docs/plans/mailbox.md §9.7, #1447).
 *
 * A `PreToolUse` hook sees every tool call the CLI makes, in every permission mode, and its decision stands in for the CLI's own question. Running
 * the turn under a narrower mode was not enough: a tool that needs no permission (Agent, CronCreate, ScheduleWakeup, TaskStop, SendMessage) never
 * reaches `canUseTool` there, and the SDK's own warning on `bypassPermissions` says to use this hook to gate every call. So the host's
 * `RequestTurn` decides each call: a read goes on to the CLI's own flow, a step the person allowed goes on without a second question, and a refused
 * one does not run and gives the model the reason.
 *
 * Left to their own gates, which ask in the call itself: Centralu's own tools (`runParsed`) and an attached app's (`SessionApps.call`), the latter
 * only for a server this session really has attached, never by name alone (#93).
 *
 * Fails closed: a question that cannot be asked, or a turn that cannot be told, refuses the step (a hook that throws would let the tool run). Nothing
 * else here runs in a turn that is not a request.
 */
export function requestTurnHooks(opts: Pick<CreateSessionOpts, 'requestTurn' | 'apps'>, ownServer: () => boolean): { PreToolUse: HookCallbackMatcher[] } | undefined {
  const request = opts.requestTurn
  if (!request) return undefined
  const hook: HookCallback = async (input, _toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const name = input.tool_name
    try {
      if (!request.active()) {
        // The person's own turn: nothing is asked, but what is read is kept, as a later request's reply could carry it to a session
        try {
          request.seen(name, isRecord(input.tool_input) ? input.tool_input : {})
        } catch (err) {
          console.error(`[claude] a read could not be noted: ${err instanceof Error ? err.message : String(err)}`)
        }
        return {}
      }
      if (name === 'AskUserQuestion') {
        // Answered by the person with no card of this gate, and the answer is text the asker could have got the person to type: read, for the record
        request.seen(name, isRecord(input.tool_input) ? input.tool_input : {})
        return {}
      }
      if (isOrchestratorTool(name) && ownServer()) return {}
      // An attached app's tool asks in the call itself (`SessionApps.call`), naming the session: allowed here so the CLI does not put a card of its own first
      const app = appToolOf(name)
      if (app && opts.apps?.current().some((a) => a.server === app.server)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
      const answer = await request.ask(name, isRecord(input.tool_input) ? input.tool_input : {}, signal)
      if (!answer.allowed) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: answer.message } }
      return answer.asked ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } : {}
    } catch (err) {
      console.error(`[claude] a request's step ${name} could not be put to the person: ${err instanceof Error ? err.message : String(err)}`)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Nothing was done: the host could not ask the person.' } }
    }
  }
  return { PreToolUse: [{ hooks: [hook], timeout: HOOK_TIMEOUT_SECONDS }] }
}
