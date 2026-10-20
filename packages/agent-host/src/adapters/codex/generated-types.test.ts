/**
 * generated/ is what `pnpm codex:bindings` wrote, unedited (#1339, #1383 review).
 *
 * The adapter is compiled against these types, and they are light tier, so a hand edit (a field renamed to make
 * the build pass, say) would otherwise land unseen until the weekly drift run. `codex:bindings` writes the hash of
 * every file beside them (protocol-types.sha256), and this holds generated/ to it: a file edited, added or removed by
 * hand fails here, in every pull request's CI, unless the manifest changes with it, in plain sight.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GENERATED = join(HERE, 'generated')

/** The manifest's lines: path → sha256, and the Codex that wrote them */
function manifest(text: string): { version: string; files: Map<string, string> } {
  const files = new Map<string, string>()
  let version = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) version = line.slice(2)
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line)
    if (m?.[1] && m[2]) files.set(m[2], m[1])
  }
  return { version, files }
}

/** generated/ as it is: path (as the manifest writes it) → sha256 of the text */
function onDisk(): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of readdirSync(GENERATED, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue
    const text = readFileSync(join(GENERATED, entry), 'utf8')
    out.set(`generated/${relative(GENERATED, join(GENERATED, entry)).split(sep).join('/')}`, createHash('sha256').update(text, 'utf8').digest('hex'))
  }
  return out
}

describe('the Codex types the adapter is compiled against', () => {
  it('are exactly what pnpm codex:bindings wrote', () => {
    const { version, files } = manifest(readFileSync(join(HERE, 'protocol-types.sha256'), 'utf8'))
    expect(version).toMatch(/^codex-cli \d/)
    const disk = onDisk()
    const edited = [...disk].filter(([file, hash]) => files.get(file) !== hash).map(([file]) => file)
    const gone = [...files.keys()].filter((file) => !disk.has(file))
    expect({ edited, gone }, `generated/ is not what pnpm codex:bindings wrote with ${version}: run it again instead of editing by hand`).toEqual({ edited: [], gone: [] })
  })

  it('reads the manifest it checks against', () => {
    const { version, files } = manifest(`# codex-cli 0.163.0\n${'a'.repeat(64)}  generated/v2/X.ts\nnot a line\n`)
    expect(version).toBe('codex-cli 0.163.0')
    expect([...files]).toEqual([['generated/v2/X.ts', 'a'.repeat(64)]])
  })
})
