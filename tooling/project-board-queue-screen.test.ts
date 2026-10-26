import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { judgeBatch } from '../.centralu/apps/project-board/queue-screen.mjs'

/*
 * The judge of whether a batch changes the screen (queue-screen.mjs, #1538), run as the board runs it: main's
 * .github/scripts/ci-changes.mjs written to a temporary folder and started with `--screen`.
 *
 * queue/batch-220 (#1562, 2026-10-26): on the owner's Mac every batch was "could not be told whether it changes the screen
 * (Unexpected end of JSON input)". macOS's temporary folder is behind a symlink (/var -> /private/var), and the judge runs
 * its main only when `import.meta.url` (the real path) is `process.argv[1]` (the path it was started with): from there it
 * printed nothing and exited 0. A temporary folder behind a symlink (a junction on Windows) stands for it here.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CI_CHANGES = readFileSync(join(REPO_ROOT, '.github/scripts/ci-changes.mjs'), 'utf8')

const hoisted = vi.hoisted((): { judge: string | null; files: string[] | null } => ({ judge: '', files: [] }))

vi.mock('../.centralu/apps/project-board/github.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    readRepoFile: async () => hoisted.judge,
    readCompareFiles: async () => hoisted.files,
  }
})

const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const
let root = ''
let saved: Record<string, string | undefined> = {}

/** Points the temporary folder (os.tmpdir(), read on every call) at `dir` */
const tempAt = (dir: string) => {
  for (const k of TMP_VARS) process.env[k] = dir
}

beforeEach(() => {
  saved = Object.fromEntries(TMP_VARS.map((k) => [k, process.env[k]]))
  root = mkdtempSync(join(tmpdir(), 'cc-queue-screen-test-'))
  hoisted.judge = CI_CHANGES
  hoisted.files = ['docs/guide.md']
})

afterEach(() => {
  for (const k of TMP_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(root, { recursive: true, force: true })
})

/** A temporary folder reached through a link, as macOS's /var/folders is through /var -> /private/var */
function linkedTemp() {
  const real = join(root, 'private-var')
  mkdirSync(real)
  const link = join(root, 'var')
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  return link
}

const judge = () => judgeBatch('ijun17/centralu', 'main', 'queue/batch-1')

describe('the judge of whether a batch changes the screen (queue-screen.mjs)', () => {
  it('answers from a temporary folder behind a symlink, as on macOS (queue/batch-220)', async () => {
    tempAt(linkedTemp())
    expect(await judge()).toEqual({ tier: 'quick', why: 'it changes nothing the UI scenarios see (1 file)' })
    hoisted.files = ['docs/guide.md', 'packages/ui/src/App.tsx']
    expect(await judge()).toEqual({ tier: 'full', why: 'it changes the screen (packages/ui/src/App.tsx)' })
  })

  it('answers from a plain temporary folder', async () => {
    tempAt(root)
    expect(await judge()).toEqual({ tier: 'quick', why: 'it changes nothing the UI scenarios see (1 file)' })
  })

  // Empty output is "cannot judge" (the heavy jobs run), and the batch's text says what the judge did
  it('runs the heavy jobs when the judge prints nothing, and says it ended with exit code 0', async () => {
    tempAt(root)
    hoisted.judge = "process.stderr.write('Warning: something odd\\n')"
    const r = await judge()
    expect(r.tier).toBe('full')
    expect(r.why).toContain('the judge printed no answer and ended with exit code 0: Warning: something odd')
    expect(r.why).not.toContain('Unexpected end of JSON input')
  })

  it('names the exit code and the error line of a judge that crashes', async () => {
    tempAt(root)
    hoisted.judge = "console.error('TypeError: files.map is not a function'); process.exit(3)"
    const r = await judge()
    expect(r.tier).toBe('full')
    expect(r.why).toContain('the judge ended with exit code 3: TypeError: files.map is not a function')
  })

  it('says what the judge printed when it is not JSON', async () => {
    tempAt(root)
    hoisted.judge = "console.log('The full tier: a manual run.')"
    const r = await judge()
    expect(r.tier).toBe('full')
    expect(r.why).toContain('the judge printed something else than JSON: The full tier: a manual run.')
  })
})
