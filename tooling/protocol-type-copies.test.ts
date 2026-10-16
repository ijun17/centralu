/**
 * A shape the protocol declares is declared once (#428, docs/protocol.md §4).
 *
 * The host and the platform used to write protocol types out again by hand, and the copies drifted: the host's
 * `GitCommit` had no `sessionName`, its error bundle no `sentAt`, the Tauri shell's `HostBuild` was another thing under
 * the protocol's name. This fails when a file there declares a type or interface under a name the protocol exports:
 * import it (`import type`) and re-export it if callers use the local name, or give a type that only looks alike a
 * name of its own.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Block and line comments, so prose that names a protocol type cannot trip it */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/test-helpers\.ts$/.test(name) ? [p] : []
  })
}

const protocolNames = new Set(
  sources(join(ROOT, 'packages/protocol/src')).flatMap((f) =>
    [...stripComments(readFileSync(f, 'utf8')).matchAll(/^export (?:type|const|interface) (\w+)/gm)].map((m) => m[1]!),
  ),
)

/** Every local `type X =` / `interface X` in `dirs` whose name the protocol exports */
function copies(dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    sources(join(ROOT, dir)).flatMap((f) =>
      [...stripComments(readFileSync(f, 'utf8')).matchAll(/^\s*(?:export\s+)?(?:declare\s+)?(?:type|interface)\s+(\w+)\b(?!\s*,)/gm)]
        .map((m) => m[1]!)
        .filter((name) => protocolNames.has(name))
        .map((name) => `${relative(ROOT, f)}: ${name}`),
    ),
  )
}

describe('protocol types are imported, not copied', () => {
  it('reads the protocol’s names', () => {
    // A guard that matched nothing would pass forever
    for (const name of ['GitCommit', 'FsEntry', 'HostBuild', 'SessionActivity', 'ProjectConsent']) expect(protocolNames).toContain(name)
  })

  it('agent-host and the platform declare no type under a protocol name', () => {
    expect(copies(['packages/agent-host/src', 'packages/platform/src'])).toEqual([])
  })
})
