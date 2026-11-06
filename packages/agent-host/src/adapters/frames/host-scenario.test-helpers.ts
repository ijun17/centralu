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
  /** The kinds of card the host may raise in the run, which the recording script allows; any other fails it (none by default) */
  cards?: readonly string[]
  /** The recorded session's project is trusted by the person (a call that gives work outside it waits for that) */
  trusted?: boolean
  /** The host also has a second project (`{other}` in a prompt is its name), for a tool that reaches another project */
  otherProject?: boolean
  /** First message of a session in the second project (a call to it needs one the person has opened) */
  otherSession?: string
  /** A text longer than this many characters is cut in the recording (a bulky output that only fills the context): the tool's own figures stay */
  cutText?: number
  /** Events of the recorded session the run waits for once the turns have ended, all at once and in any order (the host starts turns and compactions of its own) */
  then?: readonly { type: string; label: string }[]
  /** One more turn sent to the recorded session once the `then` events have come, and waited for (what the session is like after them) */
  after?: string
}
