// The revert check's vitest reporter (scripts/pre-pr.mjs): ends the run at the first test that passes and is not one of the
// base's, CC_PRE_PR_KNOWN naming a JSON list of `file` NUL `name`. That test is the check's finding; the ones after it cannot
// change the answer, and with the change reverted they often fail only at their time limit.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

export default class StopAtNewPass {
  onInit(vitest) {
    this.vitest = vitest
    this.known = new Set(JSON.parse(readFileSync(process.env.CC_PRE_PR_KNOWN ?? '', 'utf8')))
  }

  onTestCaseResult(test) {
    if (test.result().state !== 'passed') return
    const file = relative(this.vitest.config.root, test.module.moduleId).split('\\').join('/')
    if (!this.known.has(`${file}\0${test.fullName}`)) void this.vitest.cancelCurrentRun('a new test passes without the change')
  }
}
