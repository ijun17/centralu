import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'

/** The variables a Claude session sets for its own children, naming its inbox */
const INHERITED_INBOX = ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'] as const

/**
 * Closes Claude's own cross-session channel for every session Centralu starts, under every preset (#569;
 * docs/agent-host/adapters/claude-query-options.md): it reaches another session past the relations, the record and the
 * guards Centralu's own messaging keeps.
 */
export function withoutCrossSessionMessaging<T extends Omit<Options, 'settings'> & { settings?: Settings }>(options: T) {
  const env: NonNullable<Options['env']> = {
    ...process.env,
    ...options.env,
    // Undocumented and version-sensitive (peer listing, sends and inbox binding off in CLI 2.1.263–2.1.289): the
    // refusal and discovery denies below stay, as peer traffic bypasses ask_project consent.
    CLAUDE_CODE_HARBOR_KITE: '0',
  }
  // A host started inside a Claude session (`pnpm app:dev`, `centralu serve`) inherits its inbox socket and token: the
  // parent's secret, whose socket path the CLI registers with. No child of Centralu takes them, whoever set them.
  for (const key of INHERITED_INBOX) delete env[key]
  return {
    ...options,
    settings: { ...options.settings, crossSessionInbound: 'refuse' as const },
    // SendMessage also continues this session's own subagents, so it must remain available.
    disallowedTools: [...new Set([...(options.disallowedTools ?? []), 'ListAgents', 'ListPeers'])],
    env,
  }
}
