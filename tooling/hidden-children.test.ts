import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **Every child the host starts is hidden** (docs/runtime-lessons.md ST13, #983).
 *
 * The host runs without a console on Windows (`CREATE_NO_WINDOW`), so a console program it starts without
 * `windowsHide: true` opens a window of its own: a flash for every git call, every `--version` probe, every ssh. That
 * held for each site written so far only because someone remembered; this finds one that forgot.
 *
 * What counts as a start: a call to a function imported from `node:child_process` (`spawn`, `execFile`, `exec`,
 * `fork` and their sync forms, under any local name) or to one made from it with `promisify`. The call's own text must
 * say `windowsHide` (and not `windowsHide: false`), so options built elsewhere and passed by name do not pass: write
 * them at the call. child_process reached any other way (a namespace or default import, `require`, `import()`) is
 * reported too, since its calls cannot be followed. A call that
 * only runs off Windows (`ps`, `du`, the login shell) carries it too: it costs nothing, and the check stays one rule.
 * Not covered: node-pty (a pty is a console by design, ConPTY hides it) and the keeper's Rust.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_SRC = join(ROOT, 'packages', 'agent-host', 'src')

const STARTERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

/** The local names that start a process in this source: imports from child_process, and their promisified forms */
function starterNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [imported, local] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/)
      if (imported && STARTERS.has(imported)) names.add((local ?? imported).trim())
    }
  }
  for (const m of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*promisify\(\s*(\w+)\s*\)/g)) {
    if (names.has(m[2]!)) names.add(m[1]!)
  }
  return names
}

/** The text of the call whose `(` is at `open`, through its matching `)` */
function callText(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

/**
 * Ways of reaching child_process this check could not follow to their calls: a namespace or default import, `require`,
 * a dynamic `import()`. Each is reported, so a start cannot slip past by its spelling: import the functions by name.
 */
const UNNAMED_IMPORT = [
  /import\s+\*\s+as\s+\w+\s+from\s*['"](?:node:)?child_process['"]/g,
  /import\s+\w+\s*(?:,\s*\{[^}]*\})?\s+from\s*['"](?:node:)?child_process['"]/g,
  /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/g,
  /\bimport\(\s*['"](?:node:)?child_process['"]\s*\)/g,
]

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length

/** Each call in `source` that starts a process without `windowsHide: true`, and each import the check cannot follow, as `line: text` */
export function unhiddenStarts(source: string): string[] {
  const out: string[] = []
  for (const pattern of UNNAMED_IMPORT) {
    for (const m of source.matchAll(pattern)) out.push(`${lineOf(source, m.index!)}: not imported by name: ${m[0]}`)
  }
  for (const name of starterNames(source)) {
    // Not a method (`/re/.exec(`, `db.exec(`) and not a longer name
    for (const m of source.matchAll(new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g'))) {
      const open = m.index! + m[0].length - 1
      const call = callText(source, open)
      if (/\bwindowsHide\b/.test(call) && !/\bwindowsHide\s*:\s*false\b/.test(call)) continue
      out.push(`${lineOf(source, m.index!)}: ${name}${call.split('\n')[0]}`)
    }
  }
  return out
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'test-fixtures') sources(path, out)
    } else if (/\.(?:ts|mts|js|mjs|cjs)$/.test(entry.name) && !/\.test(?:-helpers)?\.ts$|\.d\.ts$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

describe('every child the host starts is hidden (ST13, #983)', () => {
  it('no call in the host starts a process without windowsHide', () => {
    const found = sources(HOST_SRC).flatMap((file) =>
      unhiddenStarts(readFileSync(file, 'utf8')).map((hit) => `${relative(ROOT, file).replace(/\\/g, '/')}:${hit}`),
    )
    expect(found).toEqual([])
  })

  it('the check sees the ways a call could be written', () => {
    const imports = "import { execFile, spawn as start, type ChildProcess } from 'node:child_process'\nimport { promisify } from 'node:util'\n"
    for (const body of [
      "start('git', ['status'], { cwd })",
      "execFile('du', ['-sk'], { cwd }, (err) => {})",
      "const run = promisify(execFile)\nawait run('ps', ['-A'], { timeout: 5000 })",
      "spawn('ssh', args, {\n  env,\n  stdio: 'pipe',\n})".replace('spawn', 'start'),
    ]) {
      expect(unhiddenStarts(imports + body), body).toHaveLength(1)
    }
    expect(unhiddenStarts(imports + "start('git', ['status'], { cwd, windowsHide: true })")).toEqual([])
    expect(unhiddenStarts(imports + "execFile('git', [], {\n  cwd,\n  windowsHide: true,\n}, () => {})")).toEqual([])
    // A method of the same name, a name not from child_process, and a file that imports nothing from it
    expect(unhiddenStarts(imports + "/x/.exec(line); db.exec('BEGIN'); keeper.spawn({ kind: 'pty' })")).toEqual([])
    expect(unhiddenStarts("const exec = (a: string) => a\nexec('x')")).toEqual([])
    // Said, but false
    expect(unhiddenStarts(imports + "start('git', [], { cwd, windowsHide: false })")).toHaveLength(1)
  })

  it('reports a way of reaching child_process it cannot follow to the calls', () => {
    for (const source of [
      "import * as cp from 'node:child_process'\ncp.spawn('git', [])",
      "import cp from 'child_process'\ncp.execFile('git', [])",
      "import cp, { spawn } from 'node:child_process'",
      "const cp = require('node:child_process')",
      "const { spawn } = await import('child_process')",
    ]) {
      expect(unhiddenStarts(source), source).toHaveLength(1)
    }
    expect(unhiddenStarts("import type { ChildProcess } from 'node:child_process'")).toEqual([])
  })
})
