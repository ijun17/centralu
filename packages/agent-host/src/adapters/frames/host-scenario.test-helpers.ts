/**
 * A scenario recorded through a real host (`scripts/frames-record-host.mts`, #1498): the host serves Centralu's own tools behind the
 * bridge, so a scenario is the prompts alone. No prompt names an id: the model finds them with the tools.
 */
export type HostScenario = {
  name: string
  /** First messages of sessions started in the project before the one recorded */
  helpers: readonly string[]
  /** What is sent to the recorded session, one turn each */
  turns: readonly string[]
  /**
   * A second project on the host, with one session that has had this first message (what ask_project reaches). Its project is named
   * `sidekick`, which a prompt may use, and the first project is trusted (an untrusted one may not give work outside itself)
   */
  otherProject?: { first: string }
}
