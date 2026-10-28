import { agyProgram, type AgyHome } from './agent-files.js'
import type { AgyArchive } from './release.js'

/**
 * The environment every Antigravity process starts with, sessions and the sign-in alike (docs/plans/antigravity-acp.md §4):
 * - `GEMINI_HOME`: the server's state, MCP config and token in Centralu's folder, never the person's `~/.gemini`, which their
 *   Antigravity CLI uses and which loads their global MCP servers, hooks and skills. Not all of it: the harness still writes
 *   its `webm_encoder` under `$HOME/.gemini/antigravity/bin`, which only `HOME` moves (plan §4.1, an open decision)
 * - No token store is chosen for it: the agent picks its own as shipped (1.4.3: the macOS Keychain when one is usable,
 *   otherwise a file in `GEMINI_HOME`; Windows and Linux always the file, which the agent can read, plan §4.2)
 * - `BROWSER`: the process's own helper (`browserFolder`), always set, so the person's own `BROWSER` never reaches the agent
 *   and the agent never starts a browser itself (an empty value where no helper could be written)
 */
export function agyEnv(home: AgyHome, browser: string): Record<string, string> {
  return { GEMINI_HOME: home.geminiHome, BROWSER: browser }
}

/** How the installed server starts: the registry's command and arguments, in its own folder's isolation */
export function agyLaunch(home: AgyHome, archive: AgyArchive, browser: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: agyProgram(home, archive), args: [...archive.args], env: agyEnv(home, browser) }
}
