import { NO_PATH, type ApprovalDetail } from './entities.js'

/*
 * The "always allow" rule, written once (#428). The card's suggestion and preview (core), the matcher the UI sends,
 * the rule the manager saves and the check each adapter runs before asking all read it from here. It lives in
 * protocol because it is the one package all of them may import, like `isNewerVersion`. The copies it replaces had
 * drifted into bugs: the UI trimmed a command and the host did not, so a command with surrounding whitespace never
 * matched its own rule; core read `*` anywhere as a wildcard and the host only a trailing one; and an edit with no
 * path was offered, sent and saved as the rule "(no path)", which the host never matched.
 */

/**
 * What an approval is matched against, and the matcher "always allow" suggests for it: a command's text, trimmed; a
 * file edit's path. `''` when there is nothing to remember: any other kind, and an edit whose path is unknown.
 */
export function alwaysAllowKey(detail: ApprovalDetail): string {
  if (detail.kind === 'command') return detail.command.trim()
  if (detail.kind === 'file_edit' && detail.path.trim() !== '' && detail.path !== NO_PATH) return detail.path
  return ''
}

/**
 * Whether a key falls under a matcher: an exact match, or a prefix when the matcher ends in `*`. A `*` anywhere else
 * is a literal character. The stricter reading is the safe one: a rule never lets through more than it says.
 */
export function matchesAllowRule(key: string, matcher: string): boolean {
  return matcher.endsWith('*') ? key.startsWith(matcher.slice(0, -1)) : key === matcher
}
