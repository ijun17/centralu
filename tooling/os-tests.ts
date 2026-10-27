/**
 * The tests that run on every OS (#1599, docs/plans/os-layer.md §6): what the Windows unit job runs. Linux runs all.
 *
 * A test runs on every OS when it touches the OS, or anything it imports does, directly or through other modules.
 * "Touches the OS" is asked of each file with the lint rules themselves (tooling/eslint-platform-checks.js), so the
 * selection cannot disagree with the lint:
 * - `local/os-imports`, everywhere: it imports an OS module (`node:fs`, `node:child_process`, …), or reaches the OS
 *   through `process` (`process.kill`, `process.cwd()`, `process.env.PATH`, …) or `node:url`'s path conversions;
 * - `local/platform-checks`: it asks which OS this is (`process.platform`, `=== 'win32'`), as a test that skips a
 *   case on an OS does;
 * - or it is in the OS layer (tooling/os-layer.js `inOsLayer`), or named in `EVERY_OS_TESTS`.
 *
 * Only the checked code counts (tooling/os-layer.js `isChecked`: the packages, the apps, the npm launcher and their
 * tests). A test outside it (tooling/*.test.ts) does not count its own OS imports, nor those of the tooling and
 * scripts it imports: those read the repository as data (the repository-content guards), and run on Linux only
 * unless what they reach in the checked code touches the OS, or they ask which OS this is. A checked test that
 * touches the OS is on the allowlist, and runs.
 *
 *   tsx tooling/os-tests.ts --out <file> [--shard i/n]   the selected tests, one path per line (vitest.config.ts
 *                                                        `CC_TEST_FILES` reads it); with --shard, shard i of n,
 *                                                        balanced by the measured times (`balance`)
 *   tsx tooling/os-tests.ts --offenders                  the checked files that touch the OS outside the layer
 *   tsx tooling/os-tests.ts --tighten                    takes off the allowlist every line the code no longer needs
 *                                                        (`pnpm os:tighten`); never adds one
 *   tsx tooling/os-tests.ts --refresh-durations <vitest JSON report>...
 *                                                        rewrites tooling/test-durations.json from the reports
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Linter, type Rule } from 'eslint'
import tseslint from 'typescript-eslint'
import plugin, { loadedSpecifier } from './eslint-platform-checks.js'
import { EVERY_OS_TESTS, OS_ALLOWLIST, inOsLayer, isChecked, isRepoApp, parseOsAllowlist } from './os-layer.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** What a file says about the OS, and what it imports */
export type Scan = {
  /** The import specifiers, as written: static, `export … from`, `import()` and `require` with a string */
  imports: string[]
  /** It imports an OS module (`local/os-imports`) */
  touchesOs: boolean
  /** It asks which OS this is (`local/platform-checks`) */
  asksOs: boolean
}

let collected: string[] = []
/** vitest's calls that load a module by path: what they name is followed as an import (it may be the real module) */
const VI_LOADS = new Set(['mock', 'doMock', 'importActual', 'importMock'])
const collect: Rule.RuleModule = {
  create: () => {
    // What a node loads, by the lint rule's own reading (`loadedSpecifier`)
    const add = (node: unknown) => {
      const spec = loadedSpecifier(node)
      if (spec !== null) collected.push(spec)
    }
    return {
      ImportDeclaration: add,
      ExportAllDeclaration: add,
      ExportNamedDeclaration: add,
      ImportExpression: add,
      TSExternalModuleReference: add,
      CallExpression: (n) => {
        add(n)
        const c = n.callee
        const [first] = n.arguments
        const viLoads = c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'vi' && c.property.type === 'Identifier' && VI_LOADS.has(c.property.name)
        if (viLoads && first?.type === 'Literal' && typeof first.value === 'string') collected.push(first.value)
      },
    }
  },
}

const linter = new Linter({ cwd: ROOT, configType: 'flat' })
const CONFIG: Linter.Config[] = [
  {
    files: ['**/*.{ts,tsx,mts,cts,mjs,cjs,js,jsx}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { local: plugin, scan: { rules: { imports: collect } } },
    rules: { 'local/os-imports': ['error', { everywhere: true }], 'local/platform-checks': 'error', 'scan/imports': 'error' },
  },
]

const CODE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/

/** The questions the selection asks, over the repository with `virtual` files laid over it (for tests) */
export function osSelector(virtual: ReadonlyMap<string, string> = new Map()) {
  const scans = new Map<string, Scan>()
  const read = (file: string) => virtual.get(file) ?? readFileSync(`${ROOT}${file}`, 'utf8')
  const isFile = (file: string) => virtual.has(file) || (existsSync(`${ROOT}${file}`) && statSync(`${ROOT}${file}`).isFile())

  /** Scans a file (a repository path with `/`) once */
  function scanFile(file: string): Scan {
    const known = scans.get(file)
    if (known) return known
    collected = []
    const messages = linter.verify(read(file), CONFIG, { filename: `${ROOT}${file}` })
    const fatal = messages.find((m) => m.fatal)
    if (fatal) throw new Error(`${file}: could not be read to pick the tests (${fatal.message})`)
    const scan: Scan = {
      imports: collected,
      touchesOs: messages.some((m) => m.ruleId === 'local/os-imports'),
      asksOs: messages.some((m) => m.ruleId === 'local/platform-checks'),
    }
    scans.set(file, scan)
    return scan
  }

  /**
   * The repository file a specifier names, or null for a package outside it. `@cc/<package>` is vitest.config.ts's
   * alias for packages/<package>/src/index.ts, and `@cc/<package>/<name>` for its src/<name>/index.ts or src/<name>.ts (`@cc/protocol/client`). A relative specifier that names no file fails: a test whose imports
   * cannot be followed is not left out quietly. A file that is not code (a JSON, a stylesheet) imports nothing.
   */
  function resolveImport(from: string, specifier: string): string | null {
    const spec = specifier.replace(/\?.*$/, '')
    let base: string
    if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec))
    else if (spec.startsWith('@cc/')) {
      const [pkg = '', ...sub] = spec.slice('@cc/'.length).split('/')
      base = ['packages', pkg, 'src', ...sub, 'index'].join('/')
    } else return null
    const stem = base.replace(/\.(m?js|jsx)$/, '')
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.mjs`, `${stem}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.ts`, `${base}.tsx`, `${base.replace(/[/]index$/, '')}.ts`]
    const found = candidates.find(isFile)
    if (!found) throw new Error(`${from}: '${specifier}' names no file; the tests that run on every OS are picked by following imports`)
    return CODE.test(found) ? found : null
  }

  /**
   * Does this module, which a test reaches, touch the OS? Only the checked code and the repository's own apps count
   * (`isRepoApp`: they run on the person's machine too). The build and release scripts, tooling and e2e work on the
   * repository and touch files for that, so a test is not about the OS for importing them, nor for a helper that asks
   * the OS only to set its time limits (tooling/test-timing.ts). They are still followed, to what they import.
   */
  const touches = (file: string) => {
    if (inOsLayer(file)) return true
    if (!isChecked(file) && !isRepoApp(file)) return false
    const s = scanFile(file)
    return s.touchesOs || s.asksOs
  }

  /** Why a test runs on every OS, or null: the first module on its import path that touches the OS */
  function whyEveryOs(test: string): string | null {
    const named = EVERY_OS_TESTS.find((t) => t.file === test)
    if (named) return `named in EVERY_OS_TESTS: ${named.why}`
    if (inOsLayer(test)) return 'in the OS layer'
    const own = scanFile(test)
    if (own.asksOs) return 'asks which OS this is'
    if (isChecked(test) && own.touchesOs) return 'imports an OS module (on the allowlist)'
    const seen = new Set<string>([test])
    const queue: Array<{ file: string; via: string[] }> = [{ file: test, via: [] }]
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { file, via } = next
      for (const spec of scanFile(file).imports) {
        const target = resolveImport(file, spec)
        if (!target || seen.has(target)) continue
        seen.add(target)
        const path = [...via, target]
        if (touches(target)) return `imports ${path.join(' → ')}`
        queue.push({ file: target, via: path })
      }
    }
    return null
  }

  /**
   * The files of `files` that `keep` keeps, giving the event loop a turn after each: scanning the repository takes
   * 10–50 s, and in a test, one synchronous stretch that long fails it in the stall watch (tooling/vitest-stall-setup.ts,
   * #368) and, past 60 s, the whole vitest run.
   */
  async function filterYielding(files: readonly string[], keep: (f: string) => boolean): Promise<string[]> {
    const out: string[] = []
    for (const f of files) {
      if (keep(f)) out.push(f)
      await new Promise((done) => setImmediate(done))
    }
    return out
  }

  /** The tests that run on every OS, of `tests` */
  const selectTests = (tests: readonly string[]): Promise<string[]> => filterYielding(tests, (t) => whyEveryOs(t) !== null)

  /** The checked files that import an OS module outside the layer: what the allowlist holds */
  const offenders = async (files: readonly string[]): Promise<string[]> =>
    (await filterYielding(files, (f) => isChecked(f) && CODE.test(f) && !inOsLayer(f) && scanFile(f).touchesOs)).sort()

  return { scanFile, resolveImport, whyEveryOs, selectTests, offenders, isFile }
}

const repo = osSelector()

/** The repository's files, tracked or new (not ignored), with `/` */
export function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((f) => f !== '' && repo.isFile(f))
}

/**
 * The test files vitest runs (vitest.config.ts's projects), with `/`: all of them, or those `listed` names (a file
 * as `CC_TEST_FILES` takes it)
 */
export async function vitestFiles(listed?: string): Promise<string[]> {
  const { createVitest } = await import('vitest/node')
  const env = process.env.CC_TEST_FILES
  if (listed === undefined) delete process.env.CC_TEST_FILES
  else process.env.CC_TEST_FILES = listed
  let vitest: Awaited<ReturnType<typeof createVitest>> | undefined
  try {
    // Inside the try: a config that refuses the list throws here, and the variable is still put back
    vitest = await createVitest('test', { watch: false, run: true, config: `${ROOT}vitest.config.ts` }, {}, {})
    const specs = await vitest.globTestSpecifications()
    const files = [...new Set(specs.map((s) => posix.relative(ROOT.replace(/\\/g, '/'), s.moduleId.replace(/\\/g, '/'))))]
    return files.sort()
  } finally {
    await vitest?.close()
    if (env === undefined) delete process.env.CC_TEST_FILES
    else process.env.CC_TEST_FILES = env
  }
}

/**
 * Each test file's time on the Windows runner, in seconds, by repository path. Read by `balance`; rewritten by
 * `--refresh-durations` from the Windows shards' vitest JSON reports, which build.yml keeps as the
 * `windows-test-times-<shard>` artifacts of every run (docs/plans/os-layer.md §6.4).
 */
export const DURATIONS = 'tooling/test-durations.json'

export type Durations = Record<string, number>

export function parseDurations(text: string): Durations {
  const parsed: unknown = JSON.parse(text)
  const files = typeof parsed === 'object' && parsed !== null && 'files' in parsed ? parsed.files : null
  if (typeof files !== 'object' || files === null) throw new Error(`${DURATIONS}: no "files"`)
  const out: Durations = {}
  for (const [file, secs] of Object.entries(files)) if (typeof secs === 'number' && secs >= 0) out[file] = secs
  return out
}

export const readDurations = (): Durations => parseDurations(readFileSync(`${ROOT}${DURATIONS}`, 'utf8'))

/**
 * Splits tests into `shards` lists of about equal measured time: longest first, each to the lightest list so far, ties
 * by path, so that every shard computes the same split. A file with no measured time weighs the median of those that
 * have one, and at least a second: a new test is usually an ordinary one.
 */
export function balance(tests: readonly string[], durations: Durations, shards: number): string[][] {
  const known = tests.map((t) => durations[t]).filter((d): d is number => d !== undefined).sort((a, b) => a - b)
  const fallback = Math.max(1, known[Math.floor(known.length / 2)] ?? 1)
  const weight = (t: string) => durations[t] ?? fallback
  const order = [...tests].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))
  const lists = Array.from({ length: shards }, () => ({ files: [] as string[], secs: 0 }))
  for (const t of order) {
    const lightest = lists.reduce((min, l) => (l.secs < min.secs ? l : min))
    lightest.files.push(t)
    lightest.secs += weight(t)
  }
  return lists.map((l) => l.files.sort())
}

/** A test's path in the repository, from the absolute path a runner reported: from its first top folder of tests */
function repoPathOf(name: string): string {
  const p = name.replace(/\\/g, '/')
  const at = ['/packages/', '/tooling/'].map((d) => p.indexOf(d)).filter((i) => i >= 0)
  return at.length > 0 ? p.slice(Math.min(...at) + 1) : p
}

/** The per-file times in vitest JSON reports (`--reporter=json`), in seconds; the longest when a file repeats */
export function durationsFromReports(reports: readonly unknown[]): Durations {
  const out: Durations = {}
  for (const report of reports) {
    const results: unknown = typeof report === 'object' && report !== null && 'testResults' in report ? report.testResults : null
    if (!Array.isArray(results)) throw new Error('not a vitest JSON report: no testResults')
    for (const r of results as unknown[]) {
      if (typeof r !== 'object' || r === null || !('name' in r) || !('startTime' in r) || !('endTime' in r)) continue
      const { name, startTime, endTime } = r
      if (typeof name !== 'string' || typeof startTime !== 'number' || typeof endTime !== 'number') continue
      const file = repoPathOf(name)
      out[file] = Math.max(out[file] ?? 0, Math.round((endTime - startTime) / 100) / 10)
    }
  }
  return out
}

/** tooling/test-durations.json's text: sorted, one file per line */
export function formatDurations(durations: Durations, source: string): string {
  const files = Object.keys(durations)
    .sort()
    .map((f) => `    ${JSON.stringify(f)}: ${durations[f]}`)
  return `{\n  "source": ${JSON.stringify(source)},\n  "files": {\n${files.join(',\n')}\n  }\n}\n`
}

/**
 * The allowlist's text with every line the code no longer needs taken out (`--tighten`): a file that moved behind the
 * layer, or is gone. Comments stay; nothing is added, so a new offender still fails `os-layer.test.ts`. The merge queue
 * runs it on a conflict in the list (`.centralu/apps/project-board/project.json` `queue.conflicts.mechanical`): two pull
 * requests that each take out a line next to the other's conflict in git, and the merged tree says which lines are left.
 */
export function tightened(text: string, offenders: ReadonlySet<string>): string {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const kept = lines.filter((l) => {
    const path = l.trim()
    return path === '' || path.startsWith('#') || offenders.has(path)
  })
  return kept.join('\n') + '\n'
}

async function main(argv: string[]) {
  if (argv.includes('--tighten')) {
    const file = `${ROOT}${OS_ALLOWLIST}`
    const before = readFileSync(file, 'utf8')
    const after = tightened(before, new Set(await repo.offenders(repoFiles())))
    if (after !== before) writeFileSync(file, after)
    const count = (t: string) => parseOsAllowlist(t).length
    console.error(`${OS_ALLOWLIST}: ${count(before)} -> ${count(after)} lines`)
    return
  }
  if (argv.includes('--offenders')) {
    process.stdout.write((await repo.offenders(repoFiles())).join('\n') + '\n')
    return
  }
  if (argv.includes('--refresh-durations')) {
    const reports = argv.filter((a) => !a.startsWith('--'))
    if (reports.length === 0) throw new Error('usage: tsx tooling/os-tests.ts --refresh-durations <vitest JSON report>...')
    const durations = durationsFromReports(reports.map((f) => JSON.parse(readFileSync(f, 'utf8')) as unknown))
    const source = `the Windows unit shards' vitest JSON reports, refreshed ${new Date().toISOString().slice(0, 10)}`
    writeFileSync(`${ROOT}${DURATIONS}`, formatDurations(durations, source))
    console.error(`${DURATIONS}: ${Object.keys(durations).length} files`)
    return
  }
  const out = argv[argv.indexOf('--out') + 1]
  if (!argv.includes('--out') || !out) throw new Error('usage: tsx tooling/os-tests.ts --out <file> [--shard i/n] | --offenders | --tighten | --refresh-durations <report>...')
  const shardArg = argv.includes('--shard') ? argv[argv.indexOf('--shard') + 1] : undefined
  const shard = shardArg === undefined ? null : /^(\d+)\/(\d+)$/.exec(shardArg)
  if (shardArg !== undefined && (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2]))) throw new Error(`--shard ${shardArg}: expected i/n with 1 <= i <= n`)
  const all = await vitestFiles()
  const picked = await repo.selectTests(all)
  const why = argv.includes('--why')
  if (shard) {
    const durations = readDurations()
    const lists = balance(picked, durations, Number(shard[2]))
    const mine = lists[Number(shard[1]) - 1] ?? []
    writeFileSync(out, mine.join('\n') + '\n')
    const secs = lists.map((l) => Math.round(l.reduce((sum, t) => sum + (durations[t] ?? 0), 0)))
    console.error(`shard ${shardArg}: ${mine.length} test files; measured seconds per shard: ${secs.join(', ')}`)
  } else {
    writeFileSync(out, picked.join('\n') + '\n')
  }
  if (why) for (const t of picked) console.error(`${t}: ${repo.whyEveryOs(t)}`)
  const byPackage = new Map<string, [number, number]>()
  for (const t of all) {
    const [top = '', name = ''] = t.split('/')
    const key = top === 'packages' ? `${top}/${name}` : top
    const [n, of] = byPackage.get(key) ?? [0, 0]
    byPackage.set(key, [n + (picked.includes(t) ? 1 : 0), of + 1])
  }
  console.error(`tests that run on every OS: ${picked.length} of ${all.length} (${[...byPackage].map(([k, [n, of]]) => `${k} ${n}/${of}`).join(', ')})`)
  console.error(`written to ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
