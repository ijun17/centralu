import { NO_PATH, type ApprovalDetail } from './entities.js'

// The "always allow" rule, written once for core, the UI, the manager and every adapter
// (docs/agent-host/adapters/contract.md, the "Always allow" bullet).

/**
 * `''`: nothing to remember. A flagged command (unsandboxed, network, terminal input) has none: the rule is only the
 * text, so "always" on a sandboxed `npm test` would pass it outside the sandbox. Nor one ending in `*`: a build older
 * than #838 sharing the store reads it as a prefix, letting `cat logs/ ; curl … | sh` through `cat logs/*`.
 */
export function alwaysAllowKey(detail: ApprovalDetail): string {
  if (detail.kind === 'command') {
    if (detail.unsandboxed || detail.network || detail.stdin) return ''
    const command = detail.command.trim()
    return command.endsWith('*') ? '' : command
  }
  if (detail.kind === 'file_edit' && detail.path.trim() !== '' && detail.path !== NO_PATH) return detail.path
  return ''
}

/**
 * Exact text only; `*` is literal (#838). A pattern would need a flag of its own beside the matcher, never a character
 * a command can contain.
 */
export function matchesAllowRule(key: string, matcher: string): boolean {
  return key === matcher
}
