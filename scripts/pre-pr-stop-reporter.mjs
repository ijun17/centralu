// The revert check's vitest reporter (scripts/pre-pr.mjs): ends the run at the first test that passes and is not one of the
// base's, CC_PRE_PR_KNOWN naming a JSON list of `file` NUL `name`. That test is the check's finding; the ones after it cannot
// change the answer, and with the change reverted they often fail only at their time limit.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

/** A path relative to `root`, with `/` on every system: the file a test is named by. */
export const relFile = (root, name) => relative(root, name).split('\\').join('/')

/** A test as pre-pr and this reporter both name it: its file, and its describe titles and its own joined by ` > `. */
export const testKey = (file, name) => `${file}\0${name}`

export default class StopAtNewPass {
  onInit(vitest) {
    this.vitest = vitest
    this.known = new Set(JSON.parse(readFileSync(process.env.CC_PRE_PR_KNOWN, 'utf8')))
  }

  onTestCaseResult(test) {
    if (test.result().state !== 'passed') return
    if (!this.known.has(testKey(relFile(this.vitest.config.root, test.module.moduleId), test.fullName))) void this.vitest.cancelCurrentRun('a new test passes without the change')
  }
}
