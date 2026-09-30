import { describe, expect, it } from 'vitest'
import { MANIFEST_VERSION, parseManifest, toolNameError } from './manifest.js'

/**
 * Manifest validation (M4 A-1). The rules are a single set of zod schemas, and these tests check
 * that the set rejects with a reason a person can read, and does not reject unknown fields.
 */

const base = {
  manifestVersion: MANIFEST_VERSION,
  id: 'resource-search',
  name: 'Resource search',
  version: '0.1.0',
  description: 'Finds resources',
  server: { command: 'node', args: ['server.mjs'] },
  uses: {},
}
const parse = (over: Record<string, unknown>) => parseManifest(JSON.stringify({ ...base, ...over }))

describe('manifest', () => {
  it('reads a valid manifest — a missing optional field gets its default', () => {
    const r = parseManifest(JSON.stringify({ ...base, uses: undefined, server: { command: 'node' } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.server.args).toEqual([])
    expect(r.manifest.uses).toEqual({})
    expect(r.warnings).toEqual([])
  })

  it('id follows the naming rule from #93 exactly — rejects underscores, uppercase, and reserved words', () => {
    for (const id of ['has_underscore', 'Upper', 'centralu-x', 'centralu', '-leading', 'a'.repeat(33)]) {
      const r = parse({ id })
      expect(r.ok, id).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^id: /)
    }
    expect(parse({ id: 'a-1' }).ok).toBe(true)
  })

  it('unknown fields produce only a warning (top level, server, uses and csp all)', () => {
    const r = parse({
      futureField: 1,
      server: { command: 'node', args: [], cwd: 'x' },
      uses: { agent: true, clipboard: true },
      csp: { connectDomains: ['https://api.example.com'], scriptDomains: [] },
    })
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([
      'unknown field, ignored: futureField',
      'unknown field, ignored: server.cwd',
      'unknown field, ignored: uses.clipboard',
      'unknown field, ignored: csp.scriptDomains',
    ])
  })

  it('states a missing required field and a wrong type together with the field name', () => {
    const r = parseManifest(JSON.stringify({ ...base, name: undefined, version: 3 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('name: missing')
    expect(r.error).toMatch(/version: (?!missing)/)
  })

  it('refuses to read an unknown manifestVersion — so a field whose meaning changed is never run with its old meaning', () => {
    const r = parse({ manifestVersion: MANIFEST_VERSION + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('update Centralu')
  })

  it('home follows the tool naming rule (`__` is forbidden)', () => {
    expect(parse({ home: 'open' }).ok).toBe(true)
    const r = parse({ home: 'open__panel' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^home: .*__/)
  })

  it('a secret name is an environment variable name, and cannot take a name reserved for Centralu or the host', () => {
    expect(parse({ secrets: ['GITHUB_TOKEN'] }).ok).toBe(true)
    for (const s of ['lower', 'CENTRALU_APP_DATA', 'CC_HOST_TOKEN', '1ABC']) {
      expect(parse({ secrets: [s] }).ok, s).toBe(false)
    }
  })

  it('view.origin defaults to opaque, can be requested as app, and an unknown value is rejected', () => {
    const none = parse({})
    expect(none.ok && none.manifest.view).toBeUndefined()
    const empty = parse({ view: {} })
    expect(empty.ok && empty.manifest.view).toEqual({ origin: 'opaque' })
    const app = parse({ view: { origin: 'app' } })
    expect(app.ok && app.manifest.view).toEqual({ origin: 'app' })
    // A typo is not silently read as the default — the app fails to start, and the reason comes with the field name
    for (const origin of ['per-app', 'App', true, null]) {
      const r = parse({ view: { origin } })
      expect(r.ok, String(origin)).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^view\.origin: /)
    }
    // An unknown field, just like any other field, only warns
    const extra = parse({ view: { origin: 'app', pinned: true } })
    expect(extra.ok).toBe(true)
    expect(extra.warnings).toEqual(['unknown field, ignored: view.pinned'])
  })

  it('uses.agent is either true or a list of tool names (D-1)', () => {
    expect(parse({ uses: { agent: true } }).ok).toBe(true)
    expect(parse({ uses: { agent: ['claude', 'codex'] } }).ok).toBe(true)
    const bad = parse({ uses: { agent: ['Claude Code'] } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('not the shape of an agent tool name')
  })

  it('uses.host is a closed list — an unknown name only warns (asking for it is refused), a malformed name is an error (D-3)', () => {
    const known = parse({ uses: { host: ['sessions.list', 'git.status'] } })
    expect(known).toMatchObject({ ok: true, warnings: [] })
    const unknown = parse({ uses: { host: ['git.stat'] } })
    expect(unknown.ok).toBe(true)
    expect(unknown.warnings).toEqual(['uses.host: Centralu has no capability "git.stat" — it can give: sessions.list, git.status (asking for it is refused)'])
    expect(parse({ uses: { host: ['Git Status'] } }).ok).toBe(false)
  })

  it('an id in uses.apps follows the same naming rule', () => {
    expect(parse({ uses: { apps: ['other-app'] } }).ok).toBe(true)
    expect(parse({ uses: { apps: ['Other_App'] } }).ok).toBe(false)
  })

  it('states the reason when the input is not JSON or not an object', () => {
    const a = parseManifest('{ nope')
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('is not JSON')
    const b = parseManifest('[]')
    expect(b.ok).toBe(false)
  })
})

describe('tool naming rule', () => {
  it('rejects `__` and accepts everything else', () => {
    expect(toolNameError('get_state')).toBeNull()
    expect(toolNameError('a__b')).toMatch(/__/)
    expect(toolNameError('')).not.toBeNull()
  })
})
