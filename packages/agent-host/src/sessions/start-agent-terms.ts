/*
 * What start_agent's modules share (#428): the bounds its setup and call run within, the line that tells a refused
 * model to ask the person, the answers a standing request gives, and the place of the orchestrator's children. Moved
 * out of start-agent-flow.ts as they were, so no module that start_agent is split into imports the flow; the flow
 * still exports them.
 */
import type { SessionInfo, ToolName } from '@cc/protocol'
import type { ChildRunResult } from '../adapters/contract.js'
import type { AgentStartRequest, LowMemory } from './child-ownership.js'

/** How long start_agent waits for a model list to check the model and effort asked for, before it starts anyway (#660) */
export const START_AGENT_MODEL_CHECK_MS = 3_000

/**
 * How long start_agent may spend before the child exists: the model check, the card for the person and the session's
 * own start. Under the Codex bridge's 280 seconds, so the caller reads an answer from the host that says whether a
 * session was created, never the bridge's bare "timed out" (#660).
 */
export const START_AGENT_SETUP_MS = 200_000

/**
 * How long one start_agent call may take in all, setup and wait together: the Codex bridge's 280 seconds
 * (`APP_CALL_TIMEOUT_MS`, orchestrator-bridge.mjs) less a margin. What the setup used is taken off the wait.
 */
export const START_AGENT_CALL_MS = 270_000

/**
 * Said to the calling model when start_agent is refused or cut short (#660). A model that reads only "could not" tends
 * to do the job with its own CLI's subagents, which the person does not see in the sidebar and did not agree to.
 */
export const ASK_THE_PERSON = 'Do not do this with your own subagents instead: tell the person what stopped it and let them decide.'

/**
 * The answer while a start waits on the person (#673), or on memory (#686): the request's id is the handle agent_session
 * follows
 */
export function agentStartPending(req: AgentStartRequest, lowMemory?: LowMemory): ChildRunResult {
  return { ok: true, state: 'pending', sessionId: req.requestId, sessionName: '', tool: req.detail.tool, ...(lowMemory ? { lowMemory } : {}) }
}

/** What the person reads in the caller's session when a start_agent request ends without a session (#673) */
export function agentStartPersonText(req: Pick<AgentStartRequest, 'detail'>, how: 'denied' | 'withdrawn' | 'cancelled' | 'deleted' | 'stopped' | 'untrusted' | 'failed', why?: string): string {
  const what = `The request to start ${req.detail.tool} (“${req.detail.text}”)`
  switch (how) {
    case 'denied':
      return `${what} was denied. The session was told; no agent was started.`
    case 'cancelled':
      return `${what} was withdrawn: the call that asked was cancelled before you answered. No agent was started.`
    case 'deleted':
      return `${what} was withdrawn: this session was deleted. No agent was started.`
    case 'stopped':
      return `${what} was withdrawn by this session. No agent was started.`
    case 'untrusted':
      return `${what} was withdrawn: the project is no longer trusted. The session was told; no agent was started.`
    case 'failed':
      return `${what} was allowed, but no agent was started: ${(why ?? '').slice(0, 300)}`
    default:
      return `${what} was withdrawn before you answered. No agent was started.`
  }
}

/**
 * The place of the orchestrator's children (#853): outside any project, each child in a folder of its own, never the
 * orchestrator's (`newOrchestratorAgentFolder`, #994 review). A child has no project, so the place's id is empty: it
 * keys the per-place ceiling and names no project on the card, and a stored request carries it as its `projectId`.
 */
export const ORCHESTRATOR_PLACE = ''

/**
 * The orchestrator's place as a start reads a project, with the orchestrator's own tool as the default. It has no
 * folder: each child gets one of its own when it is made (`newOrchestratorAgentFolder`, #994 review)
 */
export function orchestratorPlace(caller: SessionInfo): { id: string; name: string; path: string; trusted: true; defaultTool: ToolName } {
  return { id: ORCHESTRATOR_PLACE, name: 'a folder of its own, outside any project', path: '', trusted: true, defaultTool: caller.tool }
}
