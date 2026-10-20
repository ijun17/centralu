/**
 * `pnpm lint`: ESLint over the repository, with the type-aware findings that predate those rules allowed up to
 * their per-file counts (tooling/lint-allowlist.ts says how).
 *
 *   pnpm lint                  fails on any finding the lists do not allow, and on an eslint-disable of their rules
 *   pnpm lint:tighten          the same, after lowering the lists to what the files hold and listing what moved
 *   pnpm lint <paths>          only these files or folders, from the repository's root (tighten then leaves
 *                              other files' lines alone, and those of a file that failed to parse)
 *   --record-all               lists every finding: only for the change that turns a rule on (see
 *                              tooling/type-aware-lint.test.ts `TURNED_ON`); fails when other errors remain
 */
import { ESLint } from 'eslint'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyAllowlist,
  ALLOWLIST_DIR,
  countedFiles,
  countFindings,
  disabledFindings,
  LINT_OPTIONS,
  listFileOf,
  otherErrors,
  packageOf,
  readAllowlist,
  tighten,
  writeAllowlist,
} from './lint-allowlist.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const FLAGS = ['--tighten', '--record-all']
const flags = new Set(args.filter((a) => a.startsWith('-')))
const paths = args.filter((a) => !a.startsWith('-'))
const unknown = [...flags].filter((f) => !FLAGS.includes(f))
if (unknown.length > 0) {
  throw new Error(`tooling/lint.ts takes ${FLAGS.join(' and ')} and paths, not ${unknown.join(' ')}; run \`pnpm exec eslint\` for ESLint's own options (\`--fix <files>\`)`)
}
if (flags.has('--record-all') && paths.length > 0) throw new Error('--record-all lints the whole repository; give it no paths')

// Read first: a list that cannot be read fails before a lint of half a minute, not after
const allow = readAllowlist(ROOT)
const eslint = new ESLint({ cwd: ROOT, ...LINT_OPTIONS })
const results = await eslint.lintFiles(paths.length > 0 ? paths : ['.'])
const disabled = disabledFindings(ROOT, results)

if (flags.has('--record-all')) {
  writeAllowlist(ROOT, countFindings(ROOT, results))
  console.log(`Recorded every type-aware finding in ${ALLOWLIST_DIR}/.`)
}
if (flags.has('--tighten')) {
  writeAllowlist(ROOT, tighten(allow, countFindings(ROOT, results), countedFiles(ROOT, results), (file) => existsSync(join(ROOT, file))))
}

const { over, loose } = flags.has('--record-all') ? { over: [], loose: 0 } : applyAllowlist(ROOT, results, flags.has('--tighten') ? readAllowlist(ROOT) : allow)
const formatter = await eslint.loadFormatter('stylish')
const text = await formatter.format(results)
// --record-all listed the type-aware findings; what it shows is everything else, which it cannot list
if (flags.has('--record-all')) {
  const others = otherErrors(results)
  if (others > 0) {
    console.log(text)
    console.log(`${others} other error(s) are not type-aware findings and were not recorded: fix them first.`)
  }
  process.exitCode = others > 0 || disabled.length > 0 ? 1 : 0
} else if (text) {
  console.log(text)
}

for (const d of disabled) {
  console.log(`${d.file}:${d.line}: an eslint-disable comment hides ${d.rule}. Type-aware rules are not turned off in place (#1339): check the value instead.`)
}
for (const o of over) {
  console.log(`${o.file}: ${o.count} findings of ${o.rule}, ${o.allowed} allowed (${ALLOWLIST_DIR}/${listFileOf(packageOf(o.file))}).`)
}

const remaining = results.flatMap((r) => r.messages.filter((m) => m.severity === 2))
const typeAware = remaining.filter((m) => m.ruleId?.startsWith('@typescript-eslint/'))
if (!flags.has('--record-all') && typeAware.length > 0) {
  console.log(
    [
      'Type-aware findings (#1339). Fix new code; the lists hold only what predates the rules.',
      '  Moved code or a renamed file: `pnpm lint:tighten` moves the count along with it (the rule total may not grow over main).',
      ...(typeAware.some((m) => /type 'Error'/.test(m.message)) ? ["  `(e as Error).message`: errorMessage(e) from '@cc/protocol'."] : []),
      ...(typeAware.some((m) => m.ruleId === '@typescript-eslint/no-unnecessary-type-assertion') ? ['  An assertion a type made unnecessary: `pnpm exec eslint --fix <files>` takes it out.'] : []),
      '  Data from outside the process (JSON.parse, a file, a socket, a stream): a zod schema or a narrowing guard, never `as`.',
    ].join('\n'),
  )
}
if (loose > 0 && !flags.has('--tighten')) console.log(`${loose} line(s) in ${ALLOWLIST_DIR}/ allow more than their file holds now: \`pnpm lint:tighten\` lowers them.`)
if (!flags.has('--record-all')) process.exitCode = remaining.length > 0 || disabled.length > 0 ? 1 : 0
