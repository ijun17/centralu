import { describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import { agyGatePaths } from '../bridge-path.js'
import { GATE_HOOK_TIMEOUT_S, pluginDirOf, removePluginRoot, writePluginRoot, type PluginFiles } from './plugin-root.js'

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

/** Files and folders by path, with their modes; a write into a folder without its write bit fails, as on disk */
function memoryFiles() {
  const files = new Map<string, { text: string; mode: number }>([
    [SOURCES.entry, { text: 'entry', mode: 0o644 }],
    [SOURCES.answer, { text: 'answer', mode: 0o644 }],
  ])
  const dirs = new Map<string, number>()
  const writable = (path: string) => {
    const mode = dirs.get(dirname(path))
    if (mode === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    if ((mode & 0o200) === 0) throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
  }
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
      files.set(path, { text, mode: 0o644 })
    },
    chmod: async (path, mode) => {
      if (files.has(path)) files.get(path)!.mode = mode
      else if (dirs.has(path)) dirs.set(path, mode)
      else throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    readdir: async (path) => {
      if (!dirs.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const kids = (m: Map<string, unknown>) => [...m.keys()].filter((p) => dirname(p) === path && p !== path)
      return [
        ...kids(dirs).map((p) => ({ name: p.slice(path.length + 1), isDirectory: () => true, isFile: () => false })),
        ...kids(files).map((p) => ({ name: p.slice(path.length + 1), isDirectory: () => false, isFile: () => true })),
      ]
    },
    rm: async (path) => {
      for (const m of [files, dirs] as Map<string, unknown>[]) for (const p of [...m.keys()]) if (p === path || p.startsWith(`${path}/`)) m.delete(p)
    },
  }
  return { api, files, dirs, text: (p: string) => files.get(p)?.text, json: (p: string) => JSON.parse(files.get(p)!.text) as Record<string, unknown> }
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
