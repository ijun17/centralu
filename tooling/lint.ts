/**
 * `pnpm lint`: ESLint over the repository, with the type-aware findings that predate those rules allowed at their
 * per-file counts (tooling/lint-allowlist.ts says how).
 *
 *   pnpm lint                  fails on a finding the lists do not hold and on an eslint-disable of a type-aware rule;
 *                              a line above what its file holds, or for a file that is gone, is only reported
 *   pnpm lint:tighten          the same, after moving a renamed file's lines to its new path (renames since the merge
 *                              base with CC_LINT_BASE, origin/main by default) and lowering the lines to what the files hold
 *   pnpm lint <paths>          only these files or folders, from the repository's root (tighten then leaves
 *                              other files' lines alone, and those of a file that failed to parse)
 *   --record-all               lists every finding: only for the change that turns a rule on (see
 *                              tooling/type-aware-lint.test.ts `TURNED_ON`); fails when other errors remain
 *
 * Two passes: the main one (eslint.config.js), then the guard pass (tooling/eslint-guard-pass.js): the rules that took over a
 * test's whole-tree guard, which no comment can switch off or configure, over the files they read (the .cjs ones too).
 *
 * Exit 0 clean, 1 findings, 2 a crash (tooling/lint-crash.ts).
 */
import './lint-crash.js'
import { ESLint } from 'eslint'
import { existsSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHeapStatistics, setFlagsFromString } from 'node:v8'
import {
  applyAllowlist,
  ALLOWLIST_DIR,
  baseCommit,
  countedFiles,
  countFindings,
  disabledFindings,
  eslintOptions,
  guardOptions,
  LISTABLE_RULES,
  lintHeapMb,
  lintFailed,
  lintHints,
  listFileOf,
  otherErrors,
  packageOf,
  readAllowlist,
  renamesSince,
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
// Before ESLint starts its threads: they take the limit that is set when they start (lintHeapMb); never lower than the process has
setFlagsFromString(`--max-old-space-size=${Math.max(lintHeapMb(totalmem()), Math.floor(getHeapStatistics().heap_size_limit / 1048576))}`)
const eslint = new ESLint(eslintOptions(ROOT))
const results = await eslint.lintFiles(paths.length > 0 ? paths : ['.'])
// The guard pass: its own configuration, and no comment configures it. A file none of its rules reads is not a result.
const guardResults = (await new ESLint(guardOptions(ROOT)).lintFiles(paths.length > 0 ? paths : ['.'])).filter((r) => r.messages.length > 0)
for (const r of guardResults) r.messages = r.messages.filter((m) => !(m.ruleId === null && m.severity === 1 && /noInlineConfig|File ignored/.test(m.message)))
const disabled = disabledFindings(ROOT, results)

if (recording) {
  writeAllowlist(ROOT, countFindings(ROOT, results))
  console.log(`Recorded every type-aware finding in ${ALLOWLIST_DIR}/.`)
  // What it recorded is not shown again; what is left is what it could not list
  for (const r of results) r.messages = r.messages.filter((m) => !(m.severity === 2 && m.ruleId && LISTABLE_RULES.has(m.ruleId)))
}
if (flags.has('--tighten')) {
  const base = baseCommit(ROOT, process.env.CC_LINT_BASE ?? 'origin/main')
  const found = base ? renamesSince(ROOT, base) : null
  const renames = found ?? []
  if (!base) console.log('No merge base with main here, so no renames: lines are only lowered.')
  else if (!found) console.log(`git could not list the renames since ${base}: lines are only lowered, and a renamed file's findings stay unlisted.`)
  const { allow: tightened, moves } = tighten(allow, countFindings(ROOT, results), countedFiles(ROOT, results), (file) => existsSync(join(ROOT, file)), renames)
  writeAllowlist(ROOT, tightened)
  for (const m of moves) console.log(`Moved ${m.count} of ${m.rule} from ${m.from} to ${m.to} (renamed).`)
}

const { over, loose } = recording ? { over: [], loose: [] } : applyAllowlist(ROOT, results, flags.has('--tighten') ? readAllowlist(ROOT) : allow)
const text = await (await eslint.loadFormatter('stylish')).format([...results, ...guardResults.filter((r) => r.messages.length > 0)])
if (text) console.log(text)

const guardLeft = guardResults.flatMap((r) => r.messages.filter((m) => m.severity === 2))
const othersLeft = () => otherErrors(results) + guardLeft.length
const left = [...results.flatMap((r) => r.messages.filter((m) => m.severity === 2)), ...guardLeft]
for (const d of disabled) {
  console.log(`${d.file}:${d.line}: an eslint-disable comment hides ${d.rule}. This rule is not turned off in place (#1339): check the value instead.`)
}
for (const o of over) console.log(`${o.file}: ${o.count} findings of ${o.rule}, ${o.allowed} listed (${ALLOWLIST_DIR}/${listFileOf(packageOf(o.file))}).`)
const stale = [...(flags.has('--tighten') ? readAllowlist(ROOT) : allow).keys()].filter((file) => !existsSync(join(ROOT, file)))
if (!recording && (loose.length > 0 || stale.length > 0)) {
  console.log(`${loose.length + stale.length} line(s) in ${ALLOWLIST_DIR}/ list more than their file holds, or a file that is gone; \`pnpm lint:tighten\` lowers them (not required).`)
}
if (recording && othersLeft() > 0) console.log(`${othersLeft()} other error(s) are not type-aware findings and were not recorded: fix them first.`)
if (!recording) for (const line of lintHints(left)) console.log(line)

process.exitCode = lintFailed({ errorsLeft: left.length, disabled: disabled.length, recording, othersLeft: othersLeft() }) ? 1 : 0
