/**
 * `pnpm lint`: ESLint over the repository, with the type-aware findings that predate those rules allowed at their
 * per-file counts (tooling/lint-allowlist.ts says how).
 *
 *   pnpm lint                  fails on a finding the lists do not hold, a line above what its file holds, and an
 *                              eslint-disable of a type-aware rule
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
  eslintOptions,
  LISTABLE_RULES,
  lintFailed,
  lintHints,
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
const recording = flags.has('--record-all')
if (recording && paths.length > 0) throw new Error('--record-all lints the whole repository; give it no paths')

// Read first: a list that cannot be read fails before a lint of half a minute, not after. --record-all writes them anew.
const allow = recording ? new Map<string, Map<string, number>>() : readAllowlist(ROOT)
const eslint = new ESLint(eslintOptions(ROOT))
const results = await eslint.lintFiles(paths.length > 0 ? paths : ['.'])
const disabled = disabledFindings(ROOT, results)

if (recording) {
  writeAllowlist(ROOT, countFindings(ROOT, results))
  console.log(`Recorded every type-aware finding in ${ALLOWLIST_DIR}/.`)
  // What it recorded is not shown again; what is left is what it could not list
  for (const r of results) r.messages = r.messages.filter((m) => !(m.severity === 2 && m.ruleId && LISTABLE_RULES.has(m.ruleId)))
}
if (flags.has('--tighten')) {
  const { allow: tightened, moves } = tighten(allow, countFindings(ROOT, results), countedFiles(ROOT, results), (file) => existsSync(join(ROOT, file)))
  writeAllowlist(ROOT, tightened)
  for (const m of moves) console.log(`Listed ${m.count} of ${m.rule} in ${m.file}, as many as the rule gave up elsewhere in this run (moved code).`)
}

const { over, loose } = recording ? { over: [], loose: [] } : applyAllowlist(ROOT, results, flags.has('--tighten') ? readAllowlist(ROOT) : allow)
const text = await (await eslint.loadFormatter('stylish')).format(results)
if (text) console.log(text)

const left = results.flatMap((r) => r.messages.filter((m) => m.severity === 2))
for (const d of disabled) {
  console.log(`${d.file}:${d.line}: an eslint-disable comment hides ${d.rule}. Type-aware rules are not turned off in place (#1339): check the value instead.`)
}
for (const o of over) console.log(`${o.file}: ${o.count} findings of ${o.rule}, ${o.allowed} listed (${ALLOWLIST_DIR}/${listFileOf(packageOf(o.file))}).`)
for (const o of loose) console.log(`${o.file}: ${o.count} findings of ${o.rule}, ${o.allowed} listed: \`pnpm lint:tighten\` lowers the line.`)
if (recording && otherErrors(results) > 0) console.log(`${otherErrors(results)} other error(s) are not type-aware findings and were not recorded: fix them first.`)
if (!recording) for (const line of lintHints(left)) console.log(line)

process.exitCode = lintFailed({ errorsLeft: left.length, disabled: disabled.length, loose: loose.length, recording, othersLeft: otherErrors(results) }) ? 1 : 0
