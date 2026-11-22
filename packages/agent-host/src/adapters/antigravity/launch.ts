import { agyProgram, type AgyHome, type BrowserFolder } from './agent-files.js'
import type { AgyArchive } from './release.js'

/**
 * The environment every Antigravity process starts with, sessions and the sign-in alike (docs/plans/antigravity-acp.md §4):
 * - `GEMINI_HOME`: the server's state, MCP config and token in Centralu's folder, never the person's `~/.gemini`, which their
 *   Antigravity CLI uses and which loads their global MCP servers, hooks and skills. Not all of it: the harness still writes
 *   its `webm_encoder` under `$HOME/.gemini/antigravity/bin`, which only `HOME` moves (plan §4.1, an open decision)
 * - No token store is chosen for it: the agent picks its own as shipped (1.4.3: the macOS Keychain when one is usable,
 *   otherwise a file in `GEMINI_HOME`; Windows and Linux always the file, which the agent can read, plan §4.2)
 * - `BROWSER`: the process's own helper (`browserFolder`), always set, so the person's own `BROWSER` never reaches the agent
 *   and the agent never starts a browser itself
 * - `TMP`, `TEMP`, `TMPDIR` on Windows: the same folder's `tmp/`, so what the agent unpacks there goes with that folder
 */
function agyEnv(home: AgyHome, folder: Pick<BrowserFolder, 'browser' | 'temp'>): Record<string, string> {
  const temp: Record<string, string> = folder.temp ? { TMP: folder.temp, TEMP: folder.temp, TMPDIR: folder.temp } : {}
  return { GEMINI_HOME: home.geminiHome, BROWSER: folder.browser, ...temp }
}

/** How the installed server starts: the registry's command and arguments, in its own folder's isolation */
export function agyLaunch(home: AgyHome, archive: AgyArchive, folder: Pick<BrowserFolder, 'browser' | 'temp'>): { command: string; args: string[]; env: Record<string, string> } {
  return { command: agyProgram(home, archive), args: [...archive.args], env: agyEnv(home, folder) }
}
