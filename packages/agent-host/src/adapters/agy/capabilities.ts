import type { AdapterCapabilities } from '@cc/protocol'

/**
 * What an `agy` session can do (docs/plans/antigravity-adapter.md §9). Presence means supported: `compactCommand` and the
 * import methods are absent because print mode has no `/compact` and the CLI has no official way to read a conversation.
 */
export const AGY_CAPABILITIES: AdapterCapabilities = {
  approvals: true,
  // The hook sees every tool step, a sub-agent's included (§5.3)
  gatesSteps: true,
  // `agy` reports no context window (§6): used tokens only, and no share is drawn
  contextUsage: 'none',
  resume: true,
  exclusiveWriter: false,
  autoTitle: false,
  attachments: [],
  verbosities: [],
  // The host queues; `agy` would too, but the person's `queuedMessages` setting can turn that into an interrupt (§4.2)
  midTurnInput: false,
  backgroundTasks: false,
  builtInSubagents: false,
  processModel: 'per-session',
  instructionChannel: 'server',
  toolDeferral: true,
  // Whether a resumed process reads the prompt cache was not measured (§8)
  sleep: false,
  // `agy` reads the repository's `.agents/`, `AGENTS.md` and `GEMINI.md` and has no flag to stop it (§7.3)
  keepsRepoFilesOut: false,
}
