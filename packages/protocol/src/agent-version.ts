import { isNewerVersion } from './semver.js'

/**
 * Agent CLI versions as the host reads them and the screen compares them (#297).
 *
 * In `protocol` for the reason `semver.ts` is: the host decides which sessions to restart, the
 * session header decides whether to show "installed — this session runs", and the mock answers
 * the e2e tests. If the three compared differently, a header could offer an update the host then
 * refuses, and nothing would say why.
 */

/**
 * The version in what a CLI prints about itself, or null when there is none.
 *
 * Every shape seen so far puts a dotted version somewhere in one line:
 *
 *   claude --version          `2.1.289 (Claude Code)`
 *   codex --version           `codex-cli 0.160.0`
 *   Codex initialize          `userAgent: "centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0)"`
 *
 * (measured 2026-10-05, Claude Code 2.1.289 and codex-cli 0.160.0). The Codex user agent starts
 * with the client name we sent, then the server's version; the version after the client's own
 * name comes first, so the first match is the server's.
 */
export function parseCliVersion(text: string): string | null {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)
  return m ? m[1]! : null
}

/**
 * Whether a session's process runs an older CLI than the one installed. Unknown on either side is
 * never "older": a session whose version is not known is not restarted on a guess, and a header
 * says nothing it cannot back.
 */
export function runsOlderCli(running: string | null | undefined, installed: string | null | undefined): boolean {
  if (!running || !installed) return false
  return isNewerVersion(installed, running)
}
