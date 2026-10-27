import { describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import { agyGatePaths } from '../bridge-path.js'
import { GATE_HOOK_TIMEOUT_S, PluginRootKeeper, pluginDirOf, removePluginRoot, writePluginRoot, type PluginFiles } from './plugin-root.js'

/**
 * The per-session plugin root (docs/plans/antigravity-adapter.md §3.2): what `--add-dir` hands `agy`, under the host's
 * data folder only, with no secret in it. Written through `PluginFiles`, here an in-memory tree; the live runs
 * (`recordings/agy-1.4.8/preset-*`, `deny-rule`, `stop-card`) ran real `agy` on a root written to disk by this module.
 */

const host = pathsOf()
const join = (...parts: string[]) => host.join(...parts)
const dirname = (p: string) => host.dirname(p)
const NODE = '/usr/local/bin/node'
const SOURCES = { entry: '/src/agy-gate.mjs', answer: '/src/gate-answer.mjs' }

/**
 * Files, folders and links by path, with their modes. A new entry needs its folder's write bit and an existing file its
 * own, as on disk; a link is followed by `chmod`, `readdir` and `readFile`, and not by `lstat` and `rm`, as on disk
 */
function memoryFiles() {
  const files = new Map<string, { text: string; mode: number }>([
    [SOURCES.entry, { text: 'entry', mode: 0o644 }],
    [SOURCES.answer, { text: 'answer', mode: 0o644 }],
  ])
  const dirs = new Map<string, number>()
  const links = new Map<string, string>()
  const follow = (p: string) => links.get(p) ?? p
  const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
  const writable = (path: string) => {
    const existing = files.get(path)
    if (existing) {
      if ((existing.mode & 0o200) === 0) throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
      return
    }
    const mode = dirs.get(dirname(path))
    if (mode === undefined) throw enoent(path)
    if ((mode & 0o200) === 0) throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
  }
  const entry = (isDir: boolean, isLink: boolean) => ({ isDirectory: () => isDir, isFile: () => !isDir && !isLink, isSymbolicLink: () => isLink })
  const api: PluginFiles = {
    mkdir: async (path, o) => {
      if (o?.recursive) for (let p = path; !dirs.has(p) && p !== dirname(p); p = dirname(p)) dirs.set(p, o?.mode ?? 0o755)
      else {
        writable(path)
        dirs.set(path, o?.mode ?? 0o755)
      }
    },
    copyFile: async (from, to) => {
      writable(to)
      files.set(to, { text: files.get(from)!.text, mode: 0o644 })
    },
    writeFile: async (path, text) => {
      writable(path)
      files.set(path, { text, mode: files.get(path)?.mode ?? 0o644 })
    },
    chmod: async (path, mode) => {
      const p = follow(path)
      if (files.has(p)) files.get(p)!.mode = mode
      else if (dirs.has(p)) dirs.set(p, mode)
      else throw enoent(path)
    },
    readdir: async (path) => {
      const p = follow(path)
      if (!dirs.has(p)) throw enoent(path)
      const kids = (m: Map<string, unknown>) => [...m.keys()].filter((k) => dirname(k) === p && k !== p).map((k) => k.slice(p.length + 1))
      return [
        ...kids(dirs).map((name) => ({ name, ...entry(true, false) })),
        ...kids(files).map((name) => ({ name, ...entry(false, false) })),
        ...kids(links).map((name) => ({ name, ...entry(false, true) })),
      ]
    },
    rm: async (path) => {
      for (const m of [files, dirs, links] as Map<string, unknown>[]) for (const p of [...m.keys()]) if (p === path || p.startsWith(`${path}/`)) m.delete(p)
    },
    lstat: async (path) => {
      if (links.has(path)) return { mode: 0o777, ...entry(false, true) }
      if (dirs.has(path)) return { mode: dirs.get(path)!, ...entry(true, false) }
      if (files.has(path)) return { mode: files.get(path)!.mode, ...entry(false, false) }
      throw enoent(path)
    },
    readFile: async (path) => {
      const f = files.get(follow(path))
      if (!f) throw enoent(path)
      return f.text
    },
  }
  return { api, files, dirs, links, text: (p: string) => files.get(p)?.text, json: (p: string) => JSON.parse(files.get(p)!.text) as Record<string, unknown> }
}

async function root(extra: Partial<Parameters<typeof writePluginRoot>[0]> = {}) {
  const mem = memoryFiles()
  await mem.api.mkdir('/data', { recursive: true })
  const path = await writePluginRoot({ dataDir: '/data', sessionId: 's-1', node: NODE, gateSources: SOURCES, files: mem.api, ...extra })
  return { ...mem, path, plugin: pluginDirOf(path) }
}

describe('the plugin root', () => {
  it('lies under the data folder, one per session, and holds the plugin, the hook and the servers', async () => {
    const r = await root({ bridge: '/b/orchestrator-bridge.mjs', appServers: ['app-x'], appWaitMs: 5000 })
    expect(r.path).toBe(join('/data', 'agy', 's-1'))
    expect(r.json(join(r.plugin, 'plugin.json'))).toEqual({ name: 'centralu' })
    const hooks = r.json(join(r.plugin, 'hooks.json'))['centralu-gate'] as { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] }
    expect(hooks.PreToolUse[0]!.matcher).toBe('*')
    expect(hooks.PreToolUse[0]!.hooks[0]!.timeout).toBe(GATE_HOOK_TIMEOUT_S)
    expect(GATE_HOOK_TIMEOUT_S).toBe(900)
    expect(hooks.PreToolUse[0]!.hooks[0]!.command).toBe(`'${NODE}' '${join(r.plugin, 'gate', 'agy-gate.mjs')}'`)
    expect(r.json(join(r.plugin, 'mcp_config.json'))).toEqual({
      mcpServers: {
        centralu: { command: NODE, args: ['/b/orchestrator-bridge.mjs'] },
        'app-x': { command: NODE, args: ['/b/orchestrator-bridge.mjs'], env: { CC_APP_SERVER: 'app-x', CC_APP_WAIT_MS: '5000' } },
      },
    })
    expect(r.dirs.has(join(r.plugin, 'rules'))).toBe(false)
  })

  it('copies both gate files beside each other, so the entry finds the file it imports (#1666 review finding 2)', async () => {
    const r = await root()
    expect(r.text(join(r.plugin, 'gate', 'agy-gate.mjs'))).toBe('entry')
    expect(r.text(join(r.plugin, 'gate', 'gate-answer.mjs'))).toBe('answer')
  })

  it('writes the role text as a rule only when there is one, and no secret anywhere', async () => {
    const r = await root({ rulesText: '  Be brief.  ', bridge: '/b/bridge.mjs' })
    expect(r.text(join(r.plugin, 'rules', 'AGENTS.md'))).toBe('Be brief.\n')
    const all = ['plugin.json', 'hooks.json', 'mcp_config.json'].map((f) => r.text(join(r.plugin, f))).join('\n')
    expect(all).not.toMatch(/TOKEN|token|CC_HOST_URL|CC_AGY_GATE/)
  })

  it('is left read-only, and removing it works all the same', async () => {
    const r = await root({ rulesText: 'x' })
    for (const [p, f] of r.files) if (p.startsWith(r.path)) expect(f.mode & 0o222, p).toBe(0)
    for (const [p, mode] of r.dirs) if (p.startsWith(r.path)) expect(mode & 0o222, p).toBe(0)
    await expect(r.api.writeFile(join(r.plugin, 'hooks.json'), '{}')).rejects.toThrow(/EACCES/)
    await removePluginRoot(r.api, '/data', 's-1')
    expect([...r.files.keys(), ...r.dirs.keys()].filter((p) => p.startsWith(r.path))).toEqual([])
  })

  it('is written afresh over an earlier one, and removing one that is not there is no error', async () => {
    const r = await root({ rulesText: 'old' })
    await writePluginRoot({ dataDir: '/data', sessionId: 's-1', node: NODE, gateSources: SOURCES, files: r.api })
    expect(r.dirs.has(join(r.plugin, 'rules'))).toBe(false)
    await expect(removePluginRoot(r.api, '/data', 'never')).resolves.toBeUndefined()
  })

  it('refuses a session id that is not one path segment, so removing it cannot reach the data folder', async () => {
    const mem = memoryFiles()
    for (const sessionId of ['', '..', '../x', 'a/b', '.hidden']) {
      await expect(writePluginRoot({ dataDir: '/data', sessionId, node: NODE, gateSources: SOURCES, files: mem.api }), sessionId).rejects.toThrow(/session id/)
      await expect(removePluginRoot(mem.api, '/data', sessionId), sessionId).rejects.toThrow(/session id/)
    }
  })

  it('finds the gate files in the source tree (bridge-path.ts)', () => {
    const s = agyGatePaths()
    expect(s.entry.endsWith(join('agy', 'agy-gate.mjs')) && s.answer.endsWith(join('agy', 'gate-answer.mjs'))).toBe(true)
  })
})

describe('the plugin root keeper (#1672 deep review finding 1)', () => {
  async function kept() {
    const mem = memoryFiles()
    await mem.api.mkdir('/data', { recursive: true })
    const keeper = new PluginRootKeeper({ dataDir: '/data', sessionId: 's-1', node: NODE, gateSources: SOURCES, files: mem.api, rulesText: 'r' })
    const path = await keeper.write()
    const plugin = pluginDirOf(path)
    return { ...mem, keeper, path, plugin, hook: join(plugin, 'gate', 'agy-gate.mjs') }
  }

  it('finds nothing to restore right after writing', async () => {
    const k = await kept()
    expect(await k.keeper.intact()).toBe(true)
    expect(await k.keeper.restore()).toBe(false)
  })

  it('writes back a hook the owner made writable and replaced, as an auto-allowed command can (live: chmod u+w, cp)', async () => {
    const k = await kept()
    await k.api.chmod(k.hook, 0o644)
    await k.api.writeFile(k.hook, 'allow everything')
    expect(await k.keeper.restore()).toBe(true)
    expect(k.text(k.hook)).toBe('entry')
    expect(k.files.get(k.hook)!.mode).toBe(0o444)
    expect(await k.keeper.intact()).toBe(true)
  })

  it('counts a mode change, an added plugin, a removed file, a file made a link and a missing root as changes', async () => {
    const tamper: [string, (k: Awaited<ReturnType<typeof kept>>) => Promise<void>][] = [
      ['mode', (k) => k.api.chmod(k.hook, 0o644)],
      ['added plugin', async (k) => {
        await k.api.chmod(join(k.path, '.agents', 'plugins'), 0o755)
        await k.api.mkdir(join(k.path, '.agents', 'plugins', 'other'))
        await k.api.writeFile(join(k.path, '.agents', 'plugins', 'other', 'hooks.json'), '{}')
      }],
      ['removed', async (k) => void k.files.delete(join(k.plugin, 'rules', 'AGENTS.md'))],
      ['link', async (k) => {
        k.files.delete(k.hook)
        k.links.set(k.hook, SOURCES.entry)
      }],
      ['root gone', (k) => k.api.rm(k.path, { recursive: true })],
    ]
    for (const [what, change] of tamper) {
      const k = await kept()
      await change(k)
      expect(await k.keeper.intact(), what).toBe(false)
      expect(await k.keeper.restore(), what).toBe(true)
      expect(await k.keeper.intact(), what).toBe(true)
    }
  })

  it('never follows a root made a link into another folder when it opens the root to remove it', async () => {
    const k = await kept()
    await k.api.mkdir('/elsewhere', { recursive: true })
    k.files.set('/elsewhere/keep.sh', { text: 'x', mode: 0o755 })
    await k.api.rm(k.path, { recursive: true })
    k.links.set(k.path, '/elsewhere')
    expect(await k.keeper.restore()).toBe(true)
    expect(k.files.get('/elsewhere/keep.sh')!.mode).toBe(0o755)
    expect(k.dirs.get('/elsewhere')).toBe(0o755)
    expect(k.links.has(k.path)).toBe(false)
  })
})
