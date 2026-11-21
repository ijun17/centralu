import { isNewerVersion } from './semver.js'

// Agent CLI versions, shared so the host's restarts, the session header and the mock compare alike (#297).

/**
 * Measured shapes (2026-10-05): `2.1.289 (Claude Code)`, `codex-cli 0.160.0`, and Codex's initialize userAgent
 * `centralu/0.160.0 (…) unknown (centralu; 0.1.0)`, where the server's version comes first, after our client name.
 */
export function parseCliVersion(text: string): string | null {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)
  return m?.[1] ?? null
}

/** Unknown on either side is never older: no restart on a guess */
export function runsOlderCli(
  running: string | null | undefined,
  installed: string | null | undefined,
): boolean {
  if (!running || !installed) return false
  return isNewerVersion(installed, running)
}
