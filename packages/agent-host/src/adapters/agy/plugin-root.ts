import { createHash } from 'node:crypto'
import { pathsOf } from '../../os.js'

/**
 * The per-session plugin root an `agy` session is started with (`--add-dir <root>`, docs/plans/antigravity-adapter.md
 * §1.3, §3.2): the gate hook, Centralu's MCP servers and the role text, without writing anything to the person's
 * `~/.gemini` or to the session's folder.
 *
 *   <dataDir>/agy/<sessionId>/.agents/plugins/centralu/
 *     plugin.json        {"name": "centralu"}
 *     hooks.json         PreToolUse "*" -> the gate, timeout 900 s
 *     mcp_config.json    Centralu's bridge, and one entry per attached app
 *     rules/AGENTS.md    the role text, when the session has one
 *     gate/agy-gate.mjs, gate/gate-answer.mjs   the gate hook, copied: the entry imports the other file beside it
 *
 * **No secret is written.** The gate's address and credential, and the bridge's, reach the hook and the servers through
 * `agy`'s environment, which both inherit (measured). The files name paths only.
 *
 * The folder is left read-only (its files 0444, its folders 0555), and the gate refuses any write into it (`gate.ts`):
 * `agy` makes an `--add-dir` folder a workspace, so the agent can see it, and a hook it could rewrite would be no gate.
 * Neither stops the owner's own processes (`chmod u+w` works in a 0555 folder), so `PluginRootKeeper` checks the root
 * against what was written (every entry's kind, mode and content hash) at each turn start and each preset change, and
 * writes it again when it differs; the session then starts `agy` again before the turn runs (§3.2).
 *
 * It touches no file itself (docs/plans/os-layer.md): the caller hands it `PluginFiles`, which the OS layer's `files`
 * (#1650) and Node's `fs/promises` both are, and the gate's two files (`agyGatePaths()` in `bridge-path.ts`).
 */

const path = pathsOf()
const join = (...parts: string[]): string => path.join(...parts)

/** What the plugin root does to files: the OS layer's `files` (#1650) by the same names, so either can be handed in */
export type PluginFiles = {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  copyFile(from: string, to: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  readdir(path: string, options: { withFileTypes: true }): Promise<readonly { name: string; isDirectory(): boolean; isFile(): boolean }[]>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  /** Not following a link: a link put in the root is a change */
  lstat(path: string): Promise<{ mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>
  readFile(path: string): Promise<Uint8Array | string>
}

export const PLUGIN_NAME = 'centralu'
/** How long `agy` waits for the gate before it kills the hook and refuses the call: past a person's answer (§5.4) */
export const GATE_HOOK_TIMEOUT_S = 900
/** The MCP server name of Centralu's own tools in the plugin; `agy` calls it `<plugin>_<server>` (measured) */
export const CENTRALU_SERVER = 'centralu'

export type PluginRootOpts = {
  /** The host's data folder (`dataRoot()`), never the person's config */
  dataDir: string
  sessionId: string
  /** The node that runs the hook and the bridges (the host's own, `process.execPath`) */
  node: string
  /** The bridge script (`bridgePath()`) when the session gets Centralu's tools; absent: no MCP server at all */
  bridge?: string
  /** The attached apps' server names (`SessionApps.current()[].server`), each run through the same bridge */
  appServers?: readonly string[]
  /** How long an app bridge waits for an app call (`CC_APP_WAIT_MS`, as Codex's bridges get it) */
  appWaitMs?: number
  /** Role text the model reads as a rule (`systemPromptAppend`); absent: no rule file */
  rulesText?: string
  /** Where the gate's two files are copied from (`agyGatePaths()`) */
  gateSources: GateSources
  files: PluginFiles
}

/** The gate hook's two files: `agy-gate.mjs` imports `./gate-answer.mjs`, and a copy of the entry alone exits 1 without an answer (#1666 review finding 2) */
export type GateSources = { entry: string; answer: string }

/** The folder `--add-dir` names for this session */
export function pluginRootFor(dataDir: string, sessionId: string): string {
  // One folder below `agy/`, never the data folder or a folder beside it: removing the root removes this one folder
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error(`not a session id for a plugin root: ${JSON.stringify(sessionId)}`)
  return join(dataDir, 'agy', sessionId)
}

/** The plugin's own folder inside the root: the gate refuses writes anywhere under the root */
export const pluginDirOf = (root: string): string => join(root, '.agents', 'plugins', PLUGIN_NAME)

/** A POSIX shell word: `agy` runs a hook command with `sh -c` on macOS and Linux (measured; Windows is a later PR) */
const shellWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The `hooks.json` the gate is installed with: every tool (`"*"`), the hook entry's timeout past a person's answer */
export function hooksJson(node: string, gateEntry: string): unknown {
  return {
    'centralu-gate': {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${shellWord(node)} ${shellWord(gateEntry)}`, timeout: GATE_HOOK_TIMEOUT_S }] }],
    },
  }
}

/** The `mcp_config.json`: Centralu's bridge and one per app, their credentials left to the environment `agy` passes on */
export function mcpConfigJson(opts: Pick<PluginRootOpts, 'node' | 'bridge' | 'appServers' | 'appWaitMs'>): unknown {
  const mcpServers: Record<string, unknown> = {}
  if (opts.bridge) {
    mcpServers[CENTRALU_SERVER] = { command: opts.node, args: [opts.bridge] }
    for (const server of opts.appServers ?? []) {
      mcpServers[server] = {
        command: opts.node,
        args: [opts.bridge],
        env: { CC_APP_SERVER: server, ...(opts.appWaitMs ? { CC_APP_WAIT_MS: String(opts.appWaitMs) } : {}) },
      }
    }
  }
  return { mcpServers }
}

/** Writes the session's plugin root afresh (anything there before is removed) and returns its path, for `--add-dir` */
export async function writePluginRoot(opts: PluginRootOpts): Promise<string> {
  const { files } = opts
  const root = pluginRootFor(opts.dataDir, opts.sessionId)
  await removePluginRoot(files, opts.dataDir, opts.sessionId)
  const plugin = pluginDirOf(root)
  const gateDir = join(plugin, 'gate')
  await files.mkdir(gateDir, { recursive: true, mode: 0o700 })
  const entry = join(gateDir, 'agy-gate.mjs')
  await files.copyFile(opts.gateSources.entry, entry)
  await files.copyFile(opts.gateSources.answer, join(gateDir, 'gate-answer.mjs'))
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
  await files.writeFile(join(plugin, 'plugin.json'), json({ name: PLUGIN_NAME }))
  await files.writeFile(join(plugin, 'hooks.json'), json(hooksJson(opts.node, entry)))
  await files.writeFile(join(plugin, 'mcp_config.json'), json(mcpConfigJson(opts)))
  if (opts.rulesText?.trim()) {
    await files.mkdir(join(plugin, 'rules'), { mode: 0o700 })
    await files.writeFile(join(plugin, 'rules', 'AGENTS.md'), `${opts.rulesText.trim()}\n`)
  }
  await setModes(files, root, 0o444, 0o555)
  return root
}

/** Removes the session's plugin root, read-only as it is; nothing there is not an error */
export async function removePluginRoot(files: PluginFiles, dataDir: string, sessionId: string): Promise<void> {
  const root = pluginRootFor(dataDir, sessionId)
  // Missing: nothing to open, and `rm` with `force` says nothing either
  await setModes(files, root, 0o600, 0o700).catch(() => {})
  await files.rm(root, { recursive: true, force: true })
}

/**
 * Every file and folder under `dir`, `dir` included: folders last on the way down when locking, first when opening. A
 * link is never followed (a root made a link to another folder must not change that folder's modes): `rm` removes it
 */
async function setModes(files: PluginFiles, dir: string, fileMode: number, dirMode: number): Promise<void> {
  if (!(await files.lstat(dir)).isDirectory()) return
  const opening = (dirMode & 0o200) !== 0
  if (opening) await files.chmod(dir, dirMode)
  for (const e of await files.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await setModes(files, p, fileMode, dirMode)
    else if (e.isFile()) await files.chmod(p, fileMode)
  }
  if (!opening) await files.chmod(dir, dirMode)
}

/** What is under a plugin root: each entry by its path inside the root, with its kind, mode and, for a file, its hash */
export type PluginSnapshot = ReadonlyMap<string, string>

/** Every entry under `root` (the root included, as ''), read without following links; throws when the root is not there */
export async function snapshotPluginRoot(files: PluginFiles, root: string): Promise<PluginSnapshot> {
  const out = new Map<string, string>()
  const walk = async (rel: string): Promise<void> => {
    const p = rel ? join(root, rel) : root
    const st = await files.lstat(p)
    const mode = (st.mode & 0o7777).toString(8)
    if (st.isSymbolicLink()) out.set(rel, `link ${mode}`)
    else if (st.isFile()) out.set(rel, `file ${mode} ${createHash('sha256').update(await files.readFile(p)).digest('hex')}`)
    else if (st.isDirectory()) {
      out.set(rel, `dir ${mode}`)
      const names = (await files.readdir(p, { withFileTypes: true })).map((e) => e.name).sort()
      for (const name of names) await walk(rel ? join(rel, name) : name)
    } else out.set(rel, `other ${mode}`)
  }
  await walk('')
  return out
}

const sameSnapshot = (a: PluginSnapshot, b: PluginSnapshot): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/**
 * Keeps one session's plugin root as it was written (§3.2): `write` writes it and notes what it holds; `restore` checks
 * it and, when anything differs (a file changed, added, removed or made a link, a mode changed), writes it again and
 * says so, so the session starts `agy` again before the turn runs. The gate calls `restore` at each turn start and each
 * preset change (`AgyGate.beginTurn`, `setPermissionPreset`)
 */
export class PluginRootKeeper {
  private written: PluginSnapshot | null = null

  constructor(private readonly opts: PluginRootOpts) {}

  /** Writes the root afresh and returns its path, for `--add-dir` */
  async write(): Promise<string> {
    const root = await writePluginRoot(this.opts)
    this.written = await snapshotPluginRoot(this.opts.files, root)
    return root
  }

  /** Whether the root on disk is what `write` left; false when it was never written or cannot be read */
  async intact(): Promise<boolean> {
    if (!this.written) return false
    const now = await snapshotPluginRoot(this.opts.files, pluginRootFor(this.opts.dataDir, this.opts.sessionId)).catch(() => null)
    return now !== null && sameSnapshot(now, this.written)
  }

  /** True when the root had changed and was written again: `agy` must be started again before it runs another call */
  async restore(): Promise<boolean> {
    if (await this.intact()) return false
    await this.write()
    return true
  }
}
