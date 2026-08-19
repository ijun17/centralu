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

    expect(root.engines, 'root package.json').toEqual({ node: '>=22' })
    expect(agentHost.engines, 'packages/agent-host/package.json').toEqual({ node: '>=22' })
    expect(shim.engines, 'packaging/npm/centralu/package.json').toEqual({ node: '>=22' })
  })

  it('the declared floor still matches what better-sqlite3 actually requires', () => {
    // better-sqlite3 is the dependency that set the floor in the first place (see issue #24's
    // measurements). Resolve it live from packages/agent-host so a future version bump that
    // changes its own `engines.node` is caught here instead of silently drifting from ours.
    const require = createRequire(new URL('../packages/agent-host/package.json', import.meta.url))
    const betterSqlite3 = require('better-sqlite3/package.json') as { engines?: { node?: string } }
    const agentHost = readJson('packages/agent-host/package.json') as { engines: { node: string } }

    expect(betterSqlite3.engines?.node, 'better-sqlite3 engines.node').toBe(agentHost.engines.node)
  })
})
