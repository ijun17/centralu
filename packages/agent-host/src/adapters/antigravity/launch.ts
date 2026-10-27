import { agyProgram, type AgyHome } from './agent-files.js'
import type { AgyArchive } from './release.js'

/**
 * The environment every Antigravity process starts with, sessions and the sign-in alike (docs/plans/antigravity-acp.md §4):
 * - `GEMINI_HOME`: the server's state, MCP config and token in Centralu's folder, never the person's `~/.gemini`, which their
 *   Antigravity CLI uses and which loads their global MCP servers, hooks and skills. Not all of it: the harness still writes
 *   its `webm_encoder` under `$HOME/.gemini/antigravity/bin`, which only `HOME` moves (plan §4.1, an open decision)
 * - `AGY_ACP_FORCE_FILE_STORAGE=1`: the token in that folder's file, never the macOS Keychain, whose first write and any
 *   re-signed binary can raise an OS dialog in Centralu's name (plan §4.2 weighs this against the file being readable)
 * - `BROWSER`: the process's own helper (`browserFolder`), always set, so the person's own `BROWSER` never reaches the agent
 *   and the agent never starts a browser itself (an empty value where no helper could be written)
 */
export function agyEnv(home: AgyHome, browser: string): Record<string, string> {
  return { GEMINI_HOME: home.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1', BROWSER: browser }
}

/** How the installed server starts: the registry's command and arguments, in its own folder's isolation */
export function agyLaunch(home: AgyHome, archive: AgyArchive, browser: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: agyProgram(home, archive), args: [...archive.args], env: agyEnv(home, browser) }
}
