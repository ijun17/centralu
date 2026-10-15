import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Code intelligence off for one Claude session (#686): every enabled plugin that declares language servers is disabled
 * in that session's flag settings (the SDK's `settings` option), found through the files the CLI reads, and the known
 * TypeScript plugin always. The person's own settings files are never written. The SDK is stubbed: `query` records
 * its options and `resolveSettings` answers with the enabled plugins a test sets.
 */
const state = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], enabled: {} as Record<string, unknown>, resolved: [] as unknown[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    state.options.push(options)
    return {
      // eslint-disable-next-line require-yield -- only the options matter here; leave the stream open
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    }
  },
  resolveSettings: async (opts: unknown) => {
    state.resolved.push(opts)
    return { effective: { enabledPlugins: state.enabled }, provenance: {}, sources: [] }
  },
  filterEscalatingDefaultMode: (r: { effective: unknown }) => r.effective,
}))

const { ClaudeAdapter } = await import('./index.js')
const { KNOWN_LSP_PLUGINS, declaresLspServers, enabledPluginIds, lspPluginsOff } = await import('./lsp-plugins.js')

let config: string
const json = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

/**
 * A config folder laid out as the CLI keeps it (read on the owner's machine, CLI 2.1.x): `plugins/installed_plugins.json`
 * points at each installed copy, `plugins/known_marketplaces.json` at each marketplace's checkout
 */
function layout() {
  const market = join(config, 'plugins', 'marketplaces', 'official')
  const install = (id: string, dir: string) => join(config, 'plugins', 'cache', id.replace('@', '-'), dir)
  json(join(config, 'plugins', 'known_marketplaces.json'), {
    official: { source: { source: 'github', repo: 'x/y' }, installLocation: market },
  })
  // Anthropic's official LSP plugins declare their servers in the marketplace entry (`strict: false`), with no manifest
  // in the installed copy
  json(join(market, '.claude-plugin', 'marketplace.json'), {
    plugins: [
      { name: 'pyright-lsp', strict: false, lspServers: { python: { command: 'pyright-langserver', args: ['--stdio'] } } },
      { name: 'frontend-design', source: './plugins/frontend-design' },
    ],
  })
  const own = install('rust-tools@other', '1.0.0')
  const dotLsp = install('go-tools@other', '1.0.0')
  json(join(own, '.claude-plugin', 'plugin.json'), { name: 'rust-tools', lspServers: { rust: { command: 'rust-analyzer' } } })
  json(join(dotLsp, '.lsp.json'), { go: { command: 'gopls' } })
  json(join(config, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'pyright-lsp@official': [{ scope: 'user', installPath: install('pyright-lsp@official', '1.0.0') }],
      'frontend-design@official': [{ scope: 'user', installPath: install('frontend-design@official', 'abc') }],
      'rust-tools@other': [{ scope: 'user', installPath: own }],
      'go-tools@other': [{ scope: 'project', installPath: dotLsp }],
    },
  })
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'cc-claude-config-'))
  state.options = []
  state.resolved = []
  state.enabled = {}
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(config, { recursive: true, force: true })
})

describe('which plugins start a language server', () => {
  it('reads a plugin manifest, a .lsp.json, or the marketplace entry; a plugin without servers is not one', async () => {
    layout()
    expect(await declaresLspServers('pyright-lsp@official', config)).toBe(true)
    expect(await declaresLspServers('rust-tools@other', config)).toBe(true)
    expect(await declaresLspServers('go-tools@other', config)).toBe(true)
    expect(await declaresLspServers('frontend-design@official', config)).toBe(false)
    expect(await declaresLspServers('missing@nowhere', config)).toBe(false)
    expect(await declaresLspServers('no-marketplace', config)).toBe(false)
  })

  it('turns off the enabled ones and the known TypeScript plugin, and leaves the rest alone', async () => {
    layout()
    const enabled = {
      'pyright-lsp@official': true,
      'rust-tools@other': ['1.x'],
      'go-tools@other': false,
      'frontend-design@official': true,
    }
    expect(enabledPluginIds(enabled)).toEqual(['pyright-lsp@official', 'rust-tools@other', 'frontend-design@official'])
    expect(await lspPluginsOff(enabled, config)).toEqual({
      'typescript-lsp@claude-plugins-official': false,
      'pyright-lsp@official': false,
      'rust-tools@other': false,
    })
  })

  it('still turns off the known plugin when the plugin files cannot be read', async () => {
    expect(KNOWN_LSP_PLUGINS).toContain('typescript-lsp@claude-plugins-official')
    expect(await lspPluginsOff(undefined, join(config, 'absent'))).toEqual({ 'typescript-lsp@claude-plugins-official': false })
  })
})

describe('a Claude session without code intelligence', () => {
  it('carries the disabled plugins in its flag settings, read from the layers that session loads', async () => {
    layout()
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    state.enabled = { 'pyright-lsp@official': true, 'frontend-design@official': true }
    // An untrusted project's session reads only the person's own layer: the plugins are resolved from that layer too
    await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'safe', noCodeIntelligence: true }, () => {})
    // Beside the cross-session refusal every session carries in the same layer (cross-session.ts)
    expect(state.options.at(-1)!.settings).toEqual({
      crossSessionInbound: 'refuse',
      enabledPlugins: { 'typescript-lsp@claude-plugins-official': false, 'pyright-lsp@official': false },
    })
    expect(state.resolved.at(-1)).toEqual({ cwd: '/tmp', settingSources: ['user'] })
  })

  it('a session that keeps code intelligence turns no plugin off, so the person\'s plugins load as configured', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    await new ClaudeAdapter().createSession({ sessionId: 's2', cwd: '/tmp', permissionPreset: 'safe' }, () => {})
    expect(state.options.at(-1)!.settings).toEqual({ crossSessionInbound: 'refuse' })
  })

  it('a kept process started with it is told apart from one started without it, and older fingerprints read the same', () => {
    const adapter = new ClaudeAdapter()
    const base = { cwd: '/p', permissionPreset: 'normal' as const, projectTrusted: true }
    expect(adapter.launchSettingsFingerprint({ ...base, noCodeIntelligence: true })).not.toBe(adapter.launchSettingsFingerprint(base))
    expect(adapter.launchSettingsFingerprint(base)).toBe(JSON.stringify({ v: 2, cwd: '/p', permission: 'normal', trusted: true, noSettings: false }))
  })
})
