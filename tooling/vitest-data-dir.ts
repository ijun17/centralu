import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/*
 * **Each test file gets a data folder of its own** (#368).
 *
 * Tests never write to the person's `~/.centralu` (see vitest.config.ts), so they need some data
 * folder. It used to be one fixed folder, `<tmp>/centralu-test-data`, shared by every test file of
 * every run on the machine. The host treats its data folder as its own, and a `SessionManager`
 * sweeps it when it comes up: every handoff note no session of *its* store owns is deleted
 * (`sweepOrphanHandoffNotes`). With files running in parallel, one file's managers deleted the
 * note another file had just written. CI (2026-10-09, run 37885918963, ubuntu) failed
 * `manager.test.ts` "the dead-agent handoff record" with ENOENT reading the note it had written a
 * moment before. Reproduced with one file writing a note while another started managers: 5 of 5
 * runs lost the note with the shared folder, 0 of 20 with a folder per file.
 *
 * Vitest runs each test file in a fresh worker (`isolate`), and setup files run before the file is
 * imported, so a folder made here is the file's alone. A test that needs a folder of its own for
 * one case still sets `CC_DATA_DIR` itself.
 */
const dir = mkdtempSync(join(tmpdir(), 'centralu-test-data-'))
process.env.CC_DATA_DIR = dir

// Last of the file's afterAll hooks (they run in reverse order of registration). A process a test
// started may still be writing into it on Windows; what it leaves behind is in the temp folder.
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // left for the OS to clear with the rest of the temp folder
  }
})
