import { mkdtempSync } from 'node:fs'
import { rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/*
 * **Each test file gets a temporary folder of its own, and its data folder is in it** (#368).
 *
 * Tests never write to the person's `~/.centralu` (see vitest.config.ts), so they need some data
 * folder. It used to be one fixed folder, `<tmp>/centralu-test-data`, shared by every test file of
 * every run on the machine. The host treats its data folder as its own, and a `SessionManager`
 * sweeps it when it comes up: every handoff note no session of *its* store owns is deleted
 * (`sweepOrphanHandoffNotes`). With files running in parallel, one file's managers deleted the
 * note another file had just written. CI (2026-10-09, run 37885918963, ubuntu) failed
 * `manager-handoff.test.ts` "the dead-agent handoff record" with ENOENT reading the note it had written a
 * moment before. Reproduced with one file writing a note while another started managers: 5 of 5
 * runs lost the note with the shared folder, 0 of 20 with a folder per file.
 *
 * Vitest runs each test file in a fresh worker (`isolate`), and setup files run before the file is
 * imported, so a folder made here is the file's alone. A test that needs a folder of its own for
 * one case still sets `CC_DATA_DIR` itself.
 *
 * **The file's temporary folder is the file's `tmpdir()`, and is removed when the file ends.** Tests made their folders
 * with `mkdtempSync(join(tmpdir(), ...))` in 340 places and removed them by hand, or did not: after two weeks of runs a
 * development machine held 13,209 `cc-*` folders (81 GB), from tests that never removed theirs (`store.test.ts`,
 * `bundle-stage.test.ts`, `project-board-wait-checks.test.ts`), whose removal threw or was skipped when the test failed
 * first (`cross-project.test-helpers.ts`), or that ended before their cleanup. Pointing the temporary folder of the
 * worker (and of every process it starts) at a folder of the file's own and removing that folder last makes leaving one
 * impossible, whatever a test did. A folder that cannot be removed (a process of a test still works in it) fails the
 * file and names what is left, so it is seen instead of kept.
 */
// In the run's folder (`vitest-tmp-root.ts`), which also takes a skipped file's, whose hooks do not run
const own = mkdtempSync(join(process.env.CC_TEST_RUN_TMP ?? tmpdir(), 'cc-test-'))
process.env.TMPDIR = own
process.env.TMP = own
process.env.TEMP = own
const dir = mkdtempSync(join(tmpdir(), 'centralu-test-data-'))
process.env.CC_DATA_DIR = dir
/*
 * **Nor do tests read the person's Claude settings** (#382). The orchestrator and coordinators take the person's own
 * `defaultMode` under `normal` (`personsDefaultMode`), so a machine with a global bypass in `~/.claude` started them
 * differently from CI. A folder that does not exist reads as no settings; a test that plants settings sets its own.
 */
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config')

// Last of the file's afterAll hooks (they run in reverse order of registration)
afterAll(async () => {
  try {
    // Windows will not remove a folder a process still works in, which the last test's processes may be ending
    await rm(own, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (e) {
    const left = await readdir(own).catch(() => [])
    throw new Error(`the test file's temporary folder ${own} could not be removed (${e instanceof Error ? e.message : String(e)}); left in it: ${left.join(', ') || 'nothing seen'}`)
  }
})
