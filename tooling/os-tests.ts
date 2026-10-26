/**
 * The tests that run on every OS (#1599, docs/plans/os-layer.md §6): what the Windows unit job runs. Linux runs all.
 *
 * A test runs on every OS when it touches the OS, or anything it imports does, directly or through other modules.
 * "Touches the OS" is asked of each file with the lint rules themselves (tooling/eslint-platform-checks.js), so the
 * selection cannot disagree with the lint:
 * - `local/os-imports`, everywhere: it imports an OS module (`node:fs`, `node:child_process`, …);
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
 *   pnpm exec tsx tooling/os-tests.ts --out <file>   the selected tests, one path per line (vitest.config.ts
 *                                                    `CC_TEST_FILES` reads it)
 *   pnpm exec tsx tooling/os-tests.ts --offenders    the checked files that touch the OS outside the layer
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Linter, type Rule } from 'eslint'
import tseslint from 'typescript-eslint'
import plugin from './eslint-platform-checks.js'
import { EVERY_OS_TESTS, inOsLayer, isChecked } from './os-layer.js'

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
const collect: Rule.RuleModule = {
  create: () => {
    const add = (v: unknown) => typeof v === 'string' && collected.push(v)
    return {
      ImportDeclaration: (n) => add(n.source.value),
      ExportAllDeclaration: (n) => add(n.source.value),
      ExportNamedDeclaration: (n) => n.source && add(n.source.value),
      ImportExpression: (n) => n.source.type === 'Literal' && add(n.source.value),
      CallExpression: (n) => {
        const [first] = n.arguments
        if (n.callee.type === 'Identifier' && n.callee.name === 'require' && first?.type === 'Literal') add(first.value)
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
   * alias for packages/<package>/src/index.ts. A relative specifier that names no file fails: a test whose imports
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
    const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.mjs`, `${stem}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.ts`, `${base}.tsx`]
    const found = candidates.find(isFile)
    if (!found) throw new Error(`${from}: '${specifier}' names no file; the tests that run on every OS are picked by following imports`)
    return CODE.test(found) ? found : null
  }

  /**
   * Does this module, which a test reaches, touch the OS? Only the checked code counts: the build and release
   * scripts, tooling and e2e work on the repository and touch files for that, so a test is not about the OS for
   * importing them. They are still followed, to what they import from the checked code.
   */
  const touches = (file: string) => {
    if (inOsLayer(file)) return true
    if (!isChecked(file)) return false
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

  /** The tests that run on every OS, of `tests` */
  const selectTests = (tests: readonly string[]): string[] => tests.filter((t) => whyEveryOs(t) !== null)

  /** The checked files that import an OS module outside the layer: what the allowlist holds */
  const offenders = (files: readonly string[]): string[] =>
    files.filter((f) => isChecked(f) && CODE.test(f) && !inOsLayer(f) && scanFile(f).touchesOs).sort()

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
  const vitest = await createVitest('test', { watch: false, run: true, config: `${ROOT}vitest.config.ts` }, {}, {})
  try {
    const specs = await vitest.globTestSpecifications()
    const files = [...new Set(specs.map((s) => posix.relative(ROOT.replace(/\\/g, '/'), s.moduleId.replace(/\\/g, '/'))))]
    return files.sort()
  } finally {
    await vitest.close()
    if (env === undefined) delete process.env.CC_TEST_FILES
    else process.env.CC_TEST_FILES = env
  }
}

async function main(argv: string[]) {
  if (argv.includes('--offenders')) {
    process.stdout.write(repo.offenders(repoFiles()).join('\n') + '\n')
    return
  }
  const out = argv[argv.indexOf('--out') + 1]
  if (!argv.includes('--out') || !out) throw new Error('usage: tsx tooling/os-tests.ts --out <file> | --offenders')
  const all = await vitestFiles()
  const picked = repo.selectTests(all)
  const why = argv.includes('--why')
  writeFileSync(out, picked.join('\n') + '\n')
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
