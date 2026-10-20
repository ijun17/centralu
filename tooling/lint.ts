/**
 * `pnpm lint`: ESLint over the repository, with the type-aware findings that predate those rules allowed up to
 * their per-file counts (tooling/lint-allowlist.ts says how).
 *
 *   pnpm lint                  fails on any finding the lists do not allow
 *   pnpm lint:tighten          the same, then lowers the lists to what the files hold now
 *   pnpm lint <paths>          only these files or folders (tighten then leaves other files' lines alone)
 *   --record-all               lists every finding: only for the change that turns a rule on, which also
 *                              raises the ceilings in tooling/type-aware-lint.test.ts and says why
 *
 * Several threads (`concurrency: 'auto'`) and no cache: ESLint's cache keys a file on its own content, and a
 * type-aware finding can come from a type another file changed.
 */
import { ESLint } from 'eslint'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyAllowlist, ALLOWLIST_DIR, countFindings, listFileOf, packageOf, readAllowlist, relativeFile, tighten, writeAllowlist } from './lint-allowlist.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const paths = args.filter((a) => !a.startsWith('--'))

const eslint = new ESLint({ cwd: ROOT, concurrency: 'auto' })
const results = await eslint.lintFiles(paths.length > 0 ? paths : ['.'])
const allow = readAllowlist(ROOT)

if (flags.has('--record-all')) {
  if (paths.length > 0) throw new Error('--record-all lints the whole repository; give it no paths')
  writeAllowlist(ROOT, countFindings(ROOT, results))
  console.log(`Recorded every finding in ${ALLOWLIST_DIR}/.`)
  process.exit(0)
}

if (flags.has('--tighten')) {
  const linted = new Set(results.map((r) => relativeFile(ROOT, r.filePath)))
  writeAllowlist(ROOT, tighten(allow, countFindings(ROOT, results), linted, (file) => existsSync(join(ROOT, file))))
}

const { over, loose } = applyAllowlist(ROOT, results, allow)
const formatter = await eslint.loadFormatter('stylish')
const text = await formatter.format(results)
if (text) console.log(text)
for (const o of over) {
  console.log(`${o.file}: ${o.count} findings of ${o.rule}, ${o.allowed} allowed (${ALLOWLIST_DIR}/${listFileOf(packageOf(o.file))}). Fix the new one; the list only goes down.`)
}
if (loose > 0 && !flags.has('--tighten')) console.log(`${loose} line(s) in ${ALLOWLIST_DIR}/ allow more than their file holds now: \`pnpm lint:tighten\` lowers them.`)
process.exitCode = results.some((r) => r.errorCount > 0) ? 1 : 0
