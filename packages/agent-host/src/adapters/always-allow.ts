import type { ApprovalDetail } from '@cc/protocol'

/**
 * The "always allow" rules of one session, shared by the Claude and Codex adapters. Seeded with the saved rules at
 * session start (`addAll`), and grows with each 'always' response (`add`).
 *
 * **One rule for both adapters: 'always' adds the matcher it was given, and nothing without one.** The matcher is
 * what the UI computed and showed ("Always allow in this session: …"), and the manager saves exactly that matcher, so
 * the rule here, the saved rule and the screen are the same. Claude used to fall back to the command text when no
 * matcher came: a rule nobody saved or named, live until the process restarted (#428). An 'always' without a matcher
 * (a kind the UI has no matcher for) allows that one call.
 */
export class AlwaysAllowRules {
  private readonly matchers = new Set<string>()

  add(matcher: string): void {
    this.matchers.add(matcher)
  }

  addAll(matchers: readonly string[]): void {
    for (const m of matchers) this.matchers.add(m)
  }

  /** Only supports a trailing wildcard (`npm test*`) — the same rule as core's `matchesRule`. */
  allows(key: string): boolean {
    for (const m of this.matchers) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }
}

/**
 * The key a rule is matched against: the full command text for a command, the path for a file edit, and `''` (no key)
 * for every other kind. `skipPath` names a placeholder path that gets no key either (Claude's `'?'`).
 */
export function alwaysAllowKey(detail: ApprovalDetail, opts: { skipPath?: string } = {}): string {
  if (detail.kind === 'command') return detail.command
  if (detail.kind === 'file_edit' && (opts.skipPath === undefined || detail.path !== opts.skipPath)) return detail.path
  return ''
}
