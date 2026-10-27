/**
 * What this adapter maps or leaves out on purpose (agent-host.md §3.1, `unmapped.ts`): a step type or event outside it
 * is logged once per session. The vendor calls its step vocabulary closed, but a new one is how a feature of the CLI
 * (a compaction, say) would first show.
 */
export const KNOWN_STEPS: ReadonlySet<string> = new Set([
  // Mapped
  'agent_response',
  'tool',
  'subagent',
  // Left out on purpose: our own input echoed back, and agy's notices (a resume, a sub-agent's report), whose text is not streamed
  'user_input',
  'system_message',
])

/** The stream's events: the three mapped. `control_request` and the like are the CLI's own and reach no one */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set(['init', 'step_update', 'result'])
