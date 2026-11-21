// Reads the repository-wide guards (tooling/guards.ts) of the checkout it runs in, for `pnpm pre-pr` (scripts/pre-pr.mjs): that
// one is plain Node and imports nothing outside scripts/, so it starts this with the checkout's own tsx. Prints one line of JSON:
// every declared guard, and the tests of the ones the commits <from>..<to> change; `guards` is null when the checkout declares none.
//
//   node <checkout>/node_modules/tsx/dist/cli.mjs scripts/pre-pr-guards.mjs <from> <to>
//   -> { "guards": [{ "test": "tooling/x.test.ts", "tests": "a pattern" }], "changed": ["tooling/x.test.ts"] }
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git, nameStatus } from './pre-pr-worktrees.mjs'

const [from, to] = process.argv.slice(2)
const root = process.cwd()
const declaration = join(root, 'tooling', 'guards.ts')
if (!existsSync(declaration)) process.stdout.write(`${JSON.stringify({ guards: null, changed: [] })}\n`)
else {
  const { GUARDS, changedGuards } = await import(pathToFileURL(declaration).href)
  const text = (commit, path) => {
    try {
      return git(root, ['show', `${commit}:${path}`])
    } catch {
      return null
    }
  }
  const changes = nameStatus(root, from, to).map(({ status, path }) => ({
    path,
    before: () => (status === 'A' ? null : text(from, path)),
    after: () => (status === 'D' ? null : text(to, path)),
  }))
  process.stdout.write(`${JSON.stringify({ guards: GUARDS.map(({ test, tests }) => ({ test, tests })), changed: changedGuards(changes) })}\n`)
}
