/**
 * Codex calling Centralu's own tools (`read_session`, `mail`, `compact_self`, `start_agent`), as recorded through a real host
 * (`scripts/frames-record-host.mts`, #1498) and replayed by `codex/centralu.test.ts`. The tools are served by the host behind the
 * bridge, so a scenario is the prompts alone: `helpers` are the first messages of other sessions in the project (the
 * ones a tool reads or mails), `turns` those of the session whose recording is kept. No prompt names an id: the model finds them with the tools.
 */
export type CentraluScenario = {
  name: string
  /** First messages of sessions started in the project before the one recorded */
  helpers: readonly string[]
  /** What is sent to the recorded session, one turn each */
  turns: readonly string[]
}

export const CENTRALU_SCENARIOS: readonly CentraluScenario[] = [
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
