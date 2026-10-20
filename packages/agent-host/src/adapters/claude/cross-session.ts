import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'

/** The variables a Claude session sets for its own children, naming its inbox */
const INHERITED_INBOX = ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'] as const

/**
 * Closes Claude's own cross-session channel for every session Centralu starts, under every permission preset, `auto`
 * included (#569; `auto` since slice 0 of the mailbox plan, which narrows #603 for this one control): the channel
 * reaches another Centralu session past the relations, the record and the guards Centralu's own messaging keeps.
 * Inline SDK flag settings are separate from the files selected by settingSources.
 */
export function withoutCrossSessionMessaging<T extends Omit<Options, 'settings'> & { settings?: Settings }>(options: T) {
  const env: NonNullable<Options['env']> = {
    ...process.env,
    ...options.env,
    // Undocumented and version-sensitive: in CLI 2.1.263–2.1.289 this disables peer listing,
    // cross-session sends and inbox binding. Keep the documented refusal and discovery denies
    // below even if a future CLI removes this gate; peer traffic bypasses ask_project consent.
    CLAUDE_CODE_HARBOR_KITE: '0',
  }
  /*
   * A host started inside a Claude session (`pnpm app:dev` or `centralu serve` run by an agent) inherits that session's
   * inbox socket and token. They are the parent's inbox secret, and the CLI uses the socket path when it registers: no
   * child of Centralu takes them, whoever set them.
   */
  for (const key of INHERITED_INBOX) delete env[key]
  return {
    ...options,
    settings: { ...options.settings, crossSessionInbound: 'refuse' as const },
    // SendMessage also continues this session's own subagents, so it must remain available.
    disallowedTools: [...new Set([...(options.disallowedTools ?? []), 'ListAgents', 'ListPeers'])],
    env,
  }
}
