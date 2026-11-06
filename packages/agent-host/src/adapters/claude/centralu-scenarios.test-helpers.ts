import type { HostScenario } from '../frames/host-scenario.test-helpers.js'

/**
 * Claude Code calling Centralu's own tools through a real host (`scripts/frames-record-host.mts claude`, #1498), replayed by
 * `claude/centralu.test.ts`. The fakes of `replay.test.ts` stand in for `mail`, `recall` and `compact_self`; these are the calls whose
 * answer only a host can give: another agent's, another project's, a failure's.
 */
export const CLAUDE_CENTRALU_SCENARIOS: readonly HostScenario[] = [
  {
    name: 'centralu-agent',
    helpers: [],
    turns: ['Use start_agent to have a new agent do this job: Reply with exactly: pong . Give it tool claude and model haiku. Then tell me what it answered.'],
  },
  {
    // The agent is started to stay, then spoken to: agent_session sends a message and waits for its answer
    name: 'centralu-session',
    helpers: [],
    turns: ['Use start_agent to start a new agent with the job: Reply with exactly: one . Give it tool claude and model haiku. Then use agent_session to send that agent the message "Reply with exactly: two" and wait for its answer. Tell me what it said.'],
  },
  {
    name: 'centralu-ask',
    helpers: [],
    otherProject: true,
    otherSession: 'Reply with exactly: ready',
    trusted: true,
    turns: ['Use ask_project to ask the project named {other} this question: what is 2+2? Answer in one word. Then tell me what it answered.'],
  },
  {
    // A Centralu tool that fails: a session that does not exist
    name: 'centralu-failed',
    helpers: [],
    turns: ['Use the read_session tool of Centralu to read the session with the id "no-such-session-xyz". Then tell me what it answered, in one sentence.'],
  },
]
