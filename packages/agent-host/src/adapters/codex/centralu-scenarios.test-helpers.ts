import type { HostScenario } from '../frames/host-scenario.test-helpers.js'

/**
 * Codex calling Centralu's own tools (`read_session`, `mail`, `compact_self`, `start_agent`), as recorded through a real host
 * (`scripts/frames-record-host.mts`, #1498) and replayed by `codex/centralu.test.ts`. The tools are served by the host behind the
 * bridge, so a scenario is the prompts alone: `helpers` are the first messages of other sessions in the project (the
 * ones a tool reads or mails), `turns` those of the session whose recording is kept. No prompt names an id: the model finds them with the tools.
 */
export type CentraluScenario = HostScenario

export const CENTRALU_SCENARIOS: readonly CentraluScenario[] = [
  {
    // The context is filled past the floor (100k tokens) by one command's output, so compact_self really compacts at the turn's end
    name: 'centralu-compact-real',
    helpers: [],
    cutText: 2000,
    // About 28k tokens of the model's context for each, so four pass the floor
    turns: ['Run this same shell command four times, one call each, and look at its whole output every time (the command follows the colon): head -c 160000 /dev/urandom | base64 | fold -w 100', 'Say done. Then call the compact_self tool.'],
    then: [{ type: 'compaction', label: 'the compaction' }],
  },
  {
    // The other session answers by mail, and the host starts a turn of this one from the answer
    name: 'centralu-wake',
    helpers: ['Reply with exactly: ready'],
    turns: ['Use the mail tool to ask the other session in this project (find it with your Centralu session tools first) this question: what is 2+2? Send one mail to its session id and then end your turn: its answer will come to you by mail.'],
    then: [{ type: 'turn_complete', label: 'the turn the answer starts' }],
  },
  {
    // A child agent started without waiting, then sent a second message and waited for
    name: 'centralu-agent-session',
    helpers: [],
    turns: ['Use start_agent with wait false to start an agent for this job: Reply with exactly: one . Give it tool codex, model gpt-5.6-luna and effort low. Then use agent_session to send it the message "Reply with exactly: two" and wait for its answer. Tell me both of its answers.'],
  },
  {
    // Work given to another project while the person has not trusted this one: refused, with nothing started
    name: 'centralu-ask-untrusted',
    helpers: [],
    otherProject: true,
    turns: ['Use ask_project to have the project {other} do this job: Reply with exactly: pong . Tell me what it answered.'],
  },
  {
    // The same once the person trusts the project: another project's session does the job and its answer comes back
    name: 'centralu-ask-project',
    helpers: [],
    otherProject: true,
    otherSession: 'Reply with exactly: ready',
    trusted: true,
    turns: ['Use ask_project to have the project {other} do this job: Reply with exactly: pong . Tell me what it answered.'],
  },
  {
    name: 'centralu-read',
    helpers: ['Reply with exactly: marker'],
    turns: ['Use your Centralu tools: list the other sessions in this project, then read the conversation of the one that exists. Tell me its last word.'],
  },
  {
    name: 'centralu-mail',
    helpers: ['Reply with exactly: ready'],
    turns: ['Use the mail tool: send a short message with subject "hello" and text "ping" to the other session in this project (find it with your Centralu session tools first), then read your inbox. Then say done.'],
  },
  {
    name: 'centralu-compact',
    helpers: [],
    // A small context is not compacted: the tool says so, and the conversation goes on (it compacts over 100k tokens)
    turns: ['Reply with exactly: one', 'Call the compact_self tool now, then say done.'],
  },
  {
    name: 'centralu-agent',
    helpers: [],
    turns: ['Use start_agent to have a new agent do this job: Reply with exactly: pong . Give it tool codex, model gpt-5.6-luna and effort low. Then tell me what it answered.'],
  },
]
