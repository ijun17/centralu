import { resolveSettings, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isObj } from '../../json-value.js'

/**
 * Claude Code's code intelligence, turned off for one session (#686, `CreateSessionOpts.noCodeIntelligence`).
 *
 * **How it starts (measured 2026-10-14).** A plugin brings the language server: here `typescript-lsp@claude-plugins-official`
 * (`enabledPlugins` in `~/.claude/settings.json`, declaring `lspServers.typescript = typescript-language-server --stdio`),
 * started on the first code-navigation call and running `tsserver` (0.5–1.1 GB in this monorepo).
 * **How it is turned off.** The SDK's `settings` option is the CLI's `--settings` flag layer, the highest a person
 * controls, so `{ enabledPlugins: { <id>: false } }` there disables a plugin for this process alone; no file is written.
 * **Which plugins.** Every enabled one declaring language servers in the files the CLI reads: the installed manifest
 * (`.claude-plugin/plugin.json` `lspServers`, or a `.lsp.json`) and the marketplace entry (`.claude-plugin/marketplace.json`,
 * where Anthropic's official LSP plugins declare `lspServers` with `strict: false`). Those files are no published
 * interface, so the known TypeScript plugin is always included: a layout change can miss another server, never that one.
 */

/** Plugins known to start a language server, disabled even when reading the plugin files finds nothing */
export const KNOWN_LSP_PLUGINS: readonly string[] = ['typescript-lsp@claude-plugins-official']

/** Where Claude Code keeps its configuration: `CLAUDE_CONFIG_DIR`, or `~/.claude` */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}


/** A manifest's `lspServers`: an object of servers, or a path to a file of them */
const declares = (manifest: unknown): boolean =>
  isObj(manifest) && (isObj(manifest.lspServers) ? Object.keys(manifest.lspServers).length > 0 : typeof manifest.lspServers === 'string')

/** Whether the plugin `id` (`name@marketplace`) declares language servers, by the files under `configDir` */
export async function declaresLspServers(id: string, configDir: string): Promise<boolean> {
  const at = id.lastIndexOf('@')
  if (at <= 0) return false
  const name = id.slice(0, at)
  const marketplace = id.slice(at + 1)
  // The installed copy: its own manifest, or a .lsp.json at its root
  const installed = await readJson(join(configDir, 'plugins', 'installed_plugins.json'))
  const entries = isObj(installed) && isObj(installed.plugins) ? installed.plugins[id] : undefined
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = isObj(entry) && typeof entry.installPath === 'string' ? entry.installPath : null
    if (!path) continue
    if (declares(await readJson(join(path, '.claude-plugin', 'plugin.json')))) return true
    try {
      await access(join(path, '.lsp.json'))
      return true
    } catch {
      // no .lsp.json
    }
  }
  // The marketplace's entry for it
  const known = await readJson(join(configDir, 'plugins', 'known_marketplaces.json'))
  const place = isObj(known) && isObj(known[marketplace]) ? known[marketplace].installLocation : undefined
  if (typeof place !== 'string') return false
  const listing = await readJson(join(place, '.claude-plugin', 'marketplace.json'))
  const plugins = isObj(listing) && Array.isArray(listing.plugins) ? listing.plugins : []
  return plugins.some((p) => isObj(p) && p.name === name && declares(p))
}

/** The plugin ids `enabledPlugins` turns on: `true`, or the extended forms (a version list, an object) */
export function enabledPluginIds(enabled: unknown): string[] {
  if (!isObj(enabled)) return []
  return Object.entries(enabled)
    .filter(([, v]) => v !== false && v !== null && v !== undefined)
    .map(([id]) => id)
}

/**
 * The flag-layer `enabledPlugins` that turns off every language-server plugin this session would load. `enabled` is
 * the merged `enabledPlugins` of the layers the session reads; the known plugins are always in the answer.
 */
export async function lspPluginsOff(enabled: unknown, configDir: string = claudeConfigDir()): Promise<Record<string, false>> {
  const off: Record<string, false> = {}
  for (const id of KNOWN_LSP_PLUGINS) off[id] = false
  for (const id of enabledPluginIds(enabled)) {
    if (!(id in off) && (await declaresLspServers(id, configDir).catch(() => false))) off[id] = false
  }
  return off
}

/**
 * The `settings` option for a session that starts without code intelligence: its plugins read through the SDK's own
 * merge of the layers the session loads (`settingSources` as the session passes it), then `lspPluginsOff`.
 */
export async function noCodeIntelligenceSettings(cwd: string, sources: { settingSources?: SettingSource[] }): Promise<{ enabledPlugins: Record<string, false> }> {
  let enabled: unknown
  try {
    enabled = (await resolveSettings({ cwd, ...sources })).effective.enabledPlugins
  } catch {
    // Unreadable settings: the known plugins are still turned off
  }
  return { enabledPlugins: await lspPluginsOff(enabled) }
}
