import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Codex's settings folder.
 *
 * The codex CLI itself honors `CODEX_HOME` — if we alone hard-code the home path, we end up
 * answering whether a person using `CODEX_HOME` is logged in **by looking at the wrong folder**
 * (showing "login required" while actually logged in, or the reverse). The same goes for the
 * rollout files under `sessions/`: with `CODEX_HOME` set, the CLI writes them there, so the
 * compact summary of a handoff has to be read from there too.
 */
export function codexHome(env: { CODEX_HOME?: string } = process.env, home: string = homedir()): string {
  const custom = env.CODEX_HOME?.trim()
  return custom ? custom : join(home, '.codex')
}
