/**
 * `pnpm remote-dev <machine> --ref <commit> --repo <working copy there> [--allow-dirty]` (#1036): puts a dev build of the
 * host, made on a linked machine from one commit of a working copy there, on that machine, and switches to it through
 * the update's own steps. `machines.rollback` (Settings → Machines, "Roll back") returns to the release it replaced.
 * What it does and what it refuses: packages/agent-host/src/links/remote-dev.ts and dev-build.ts,
 * docs/plans/remote-hub.md §10.11.
 *
 * Reads the hub's store from `CC_DATA_DIR` (else `~/.centralu`), read only; `--data <folder>` names another.
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { hubDataDir, remoteDev } from '../src/links/remote-dev.js'

const USAGE = `pnpm remote-dev <machine> --ref <commit> --repo <path of the working copy there> [--allow-dirty] [--data <hub data folder>]

  <machine>       a linked machine's id, name or ssh target (Settings → Machines)
  --ref           a commit, branch or tag of this working copy; the one there must be checked out at exactly it
  --repo          the working copy on that machine, with its dependencies installed (pnpm install)
  --allow-dirty   build its uncommitted changes too; the build is then marked dirty
  --data          the hub's data folder, whose store lists the machines (default: CC_DATA_DIR, else ~/.centralu)`

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ref: { type: 'string' }, repo: { type: 'string' }, 'allow-dirty': { type: 'boolean' }, data: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const machine = positionals[0]
  if (!machine || positionals.length > 1 || !values.ref || !values.repo) {
    console.error(USAGE)
    return 2
  }
  const r = await remoteDev({
    machine,
    ref: values.ref,
    repo: values.repo,
    allowDirty: values['allow-dirty'] === true,
    dataDir: values.data ? resolve(values.data) : hubDataDir(),
    log: (line) => console.log(line),
  })
  const source = r.current.source
  console.log(
    `${r.machine} runs Centralu ${r.current.version}${source ? `, a dev build of ${source.commit.slice(0, 12)}${source.dirty ? ' with uncommitted changes' : ''}` : ''}.` +
      (r.previous ? ` Roll back to ${r.previous.version} from Settings → Machines, or update it to a release.` : ''),
  )
  return 0
}

main().then(
  (code) => (process.exitCode = code),
  (err: Error) => {
    console.error(`remote-dev: ${err.message}`)
    process.exitCode = 1
  },
)
