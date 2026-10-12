import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'

/** Inline SDK flag settings are separate from the files selected by settingSources. */
export function withoutCrossSessionMessaging<T extends Omit<Options, 'settings'> & { settings?: Settings }>(options: T) {
  const env: NonNullable<Options['env']> = {
    ...process.env,
    ...options.env,
    // Undocumented and version-sensitive: in CLI 2.1.263–2.1.289 this disables peer listing,
    // cross-session sends and inbox binding. Keep the documented refusal and discovery denies
    // below even if a future CLI removes this gate; peer traffic bypasses ask_project consent.
    CLAUDE_CODE_HARBOR_KITE: '0',
  }
  return {
    ...options,
    settings: { ...options.settings, crossSessionInbound: 'refuse' as const },
    // SendMessage also continues this session's own subagents, so it must remain available.
    disallowedTools: [...new Set([...(options.disallowedTools ?? []), 'ListAgents', 'ListPeers'])],
    env,
  }
}
