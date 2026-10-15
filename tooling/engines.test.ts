/**
 * Guards the Node version floor declared in `engines.node` (issue #24).
 *
 * Before this test existed, nothing in the repo declared `engines` at all: an install on an
 * unsupported Node version succeeded silently and only failed later, deep inside the app, in a
 * way that never mentioned Node. The fix is three declarations that have to agree:
 *
 * - root `package.json` — what a contributor's `pnpm install` checks.
 * - `packages/agent-host/package.json` — the workspace package that actually needs the floor,
 *   because it depends on `better-sqlite3`, whose own `engines.node` is what set it (`>=22`).
 * - `packaging/npm/centralu/package.json` — the shim a real user installs from npm; it is the
 *   only one of the three that can warn them *before* anything breaks.
 *
 * A declaration nobody checks drifts. If one of these is bumped (or `better-sqlite3` raises or
 * lowers its own floor) without touching the others, this test names the mismatch instead of
 * the gap resurfacing as a silent install.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<string, unknown>

describe('Node version floor stays declared and consistent (#24)', () => {
  it('root, agent-host, and the published npm shim all declare the same node floor', () => {
    const root = readJson('package.json')
    const agentHost = readJson('packages/agent-host/package.json')
    const shim = readJson('packaging/npm/centralu/package.json')

    expect(root.engines, 'root package.json').toEqual({ node: '>=22.14.0' })
    expect(agentHost.engines, 'packages/agent-host/package.json').toEqual({ node: '>=22.14.0' })
    expect(shim.engines, 'packaging/npm/centralu/package.json').toEqual({ node: '>=22.14.0' })
  })

  it('the declared floor is not below what better-sqlite3 actually needs', () => {
    // better-sqlite3 is the dependency that set the floor in the first place (see issue #24's
    // measurements). Resolve it live from packages/agent-host so a future version bump that
    // raises its own `engines.node` above ours is caught here instead of silently drifting.
    //
    // Ours is higher than its declared `>=22` on purpose (#699): it builds against Node-API 10
    // (`NAPI_VERSION=10` in its binding.gyp), which Node has from 22.14.0, and under 22.12.0 the
    // prebuilt module loads and then crashes on its first `new Database` (an access violation on
    // Windows, SIGSEGV on macOS; measured). Its `engines` never said so.
    const require = createRequire(new URL('../packages/agent-host/package.json', import.meta.url))
    const betterSqlite3 = require('better-sqlite3/package.json') as { version: string; engines?: { node?: string } }
    const agentHost = readJson('packages/agent-host/package.json') as { engines: { node: string } }
    const major = (range: string | undefined) => Number(/(\d+)/.exec(range ?? '')?.[1])

    expect(betterSqlite3.engines?.node, 'better-sqlite3 engines.node').toBeDefined()
    expect(major(agentHost.engines.node)).toBeGreaterThanOrEqual(major(betterSqlite3.engines?.node))
    // If better-sqlite3 moves to another Node-API level, the floor has to be measured again
    expect(betterSqlite3.version.split('.')[0], 'better-sqlite3 major: re-measure the floor (#699) before moving it').toBe('13')
  })

  it('names the Node-API level the floor comes from, and the launcher and the hub read the one value', () => {
    const shim = readJson('packaging/npm/centralu/package.json') as { engines: { node: string } }
    const hub = readFileSync(new URL('../packages/agent-host/src/links/install.ts', import.meta.url), 'utf8')
    // The hub reads the npm package's own engines through the bundle's copy; no second number
    expect(hub).toContain("bundled('centralu-package.json'")
    expect(shim.engines.node).toMatch(/^>=22\.14\.\d+$/)
  })

  it('the desktop keeper reads the same package.json at compile time instead of keeping a number of its own', () => {
    const node = readFileSync(new URL('../apps/desktop/src-tauri/keeper/src/host_proc/node.rs', import.meta.url), 'utf8')
    expect(node).toContain('include_str!("../../../../../../packaging/npm/centralu/package.json")')
    expect(node).not.toMatch(/MIN_NODE_MAJOR/)
    // The path in the source really is that file
    const target = new URL('../apps/desktop/src-tauri/keeper/src/host_proc/', import.meta.url)
    expect(JSON.parse(readFileSync(new URL('../../../../../../packaging/npm/centralu/package.json', target), 'utf8')).engines.node).toBe('>=22.14.0')
  })
})
