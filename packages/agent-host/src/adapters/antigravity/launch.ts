import { agyProgram, type AgyHome } from './agent-files.js'
import type { AgyArchive } from './release.js'

/**
 * The environment every Antigravity process starts with, sessions and the sign-in alike (docs/plans/antigravity-adapter.md §4):
 * - `GEMINI_HOME`: all of the agent's state in Centralu's folder (spike §3: every path it used followed it), never the
 *   person's `~/.gemini`, which their Antigravity CLI uses and which loads their global MCP servers, hooks and skills
 * - `AGY_ACP_FORCE_FILE_STORAGE=1`: the token in that folder's file, never the macOS Keychain, whose first write and any
 *   re-signed binary can raise an OS dialog in Centralu's name (plan §4.2 weighs this against the file being readable)
 */
export function agyEnv(home: AgyHome): Record<string, string> {
  return { GEMINI_HOME: home.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1' }
}

/** How the installed server starts: the registry's command and arguments, in its own folder's isolation */
export function agyLaunch(home: AgyHome, archive: AgyArchive): { command: string; args: string[]; env: Record<string, string> } {
  return { command: agyProgram(home, archive), args: [...archive.args], env: agyEnv(home) }
}
