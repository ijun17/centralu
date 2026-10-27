import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import type { GateInbound } from '../core/gate.js'
import { gateSources } from './gate-path.js'
import type { PluginFiles } from './plugin-root.js'
import type { AgyHostDeps } from './session.js'

/**
 * What the `agy` session does to files and which node runs its hook, bound to the real OS: the one place the session
 * touches it (docs/plans/os-layer.md). `plugin-root.ts` and `deny-rules.ts` take their file operations as parameters, so
 * they and the session stay free of the OS; when the OS layer's `Os` interface (#1650) lands, this file becomes
 * `os.files` handed in the same way, and `memoryOs` replaces it in tests.
 */

export const agyFiles: PluginFiles & { readFile(path: string, encoding: 'utf8'): Promise<string> } = {
  mkdir: (path, options) => fs.mkdir(path, options),
  copyFile: (from, to) => fs.copyFile(from, to),
  writeFile: (path, data) => fs.writeFile(path, data),
  chmod: (path, mode) => fs.chmod(path, mode),
  readdir: (path, options) => fs.readdir(path, options),
  rm: (path, options) => fs.rm(path, options),
  readFile: (path, encoding) => fs.readFile(path, encoding),
}

/** The node that runs the hook: the host's own */
export const nodeExecutable = process.execPath

/** The person's home folder (`~/.gemini/antigravity-cli/settings.json` is read from it) */
export const personsHome = (): string => homedir()

/** For tests: the same files, to read back what the session wrote */
export const statPath = (path: string) => fs.stat(path)

/** What the host gives the `agy` adapter (`registry.ts`): `gates` is asked per session, so the route may be built after the adapters */
export const agyHost = (gates: () => GateInbound, dataDir: string): AgyHostDeps => ({
  gates,
  dataDir,
  home: personsHome(),
  files: agyFiles,
  node: nodeExecutable,
  gateSources,
})
