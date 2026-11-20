import { NO_PATH, type ApprovalDetail } from './entities.js'

/*
 * The "always allow" rule, written once (#428). The card's suggestion and preview (core), the matcher the UI sends,
 * the rule the manager saves and the check each adapter runs before asking all read it from here. It lives in
 * protocol because it is the one package all of them may import, like `isNewerVersion`. Separate copies drift into
 * bugs: one side trims a command and the other does not, so a command with surrounding whitespace never matches its
 * own rule; one reads `*` anywhere as a wildcard and the other only a trailing one; an edit with no path is offered,
 * sent and saved as the rule "(no path)", which the host never matches.
 */

/**
 * What an approval is matched against, and the matcher "always allow" suggests for it: a command's text, trimmed; a
 * file edit's path. `''` when there is nothing to remember: any other kind, an edit whose path is unknown, and two
 * kinds of command (#838):
 *
 * - one the card flags: it runs outside the sandbox, asks for the network, or is input to a terminal already running.
 *   A rule is only the command's text, so it cannot tell such a request from the plain command: an "always" given to
 *   `npm test` in the sandbox would have let a later `npm test` outside it run with no card.
 * - one ending in `*`. This build matches it exactly, but a build before #838 reads a trailing `*` as a prefix, and
 *   such a build can serve the same store during a host swap or after a downgrade: the rule `cat logs/*` would let
 *   `cat logs/ ; curl … | sh` through there. So no such rule is written at all.
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
 * Whether a key falls under a matcher: the same text, and nothing else (#838). A `*` is a literal character wherever
 * it stands. The matcher is the whole command the person approved: a wildcard at the end would turn "always" on
 * `cat logs/*` into the prefix rule `cat logs/` and let `cat logs/ ; curl … | sh` through with no card, saved for the
 * project. Nothing offers a pattern today; one that did would need a flag of its own beside the
 * matcher, never a character a command can contain.
 */
export function matchesAllowRule(key: string, matcher: string): boolean {
  return key === matcher
}
