// How the fake gh keeps its state (tooling/fake-gh.test-helpers.ts): the fake script and the test read and write it through
// here (#1496). Plain CommonJS because the fake is a started script.
const fs = require('node:fs')

/** How long a read waits for a state that does not parse yet: far longer than a loaded machine leaves a writer descheduled */
const READ_BUDGET_MS = 5_000

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Writes `text` to `path`. Where a file can be replaced under a reader that has it open (anywhere but Windows), as a whole
 * file renamed into place, so no reader finds it half written. A write in place truncates first, and a reader that came in
 * between found half an object. Windows refuses to replace a file another process has open, and a test polling the state
 * keeps it open most of the time, so it writes in place there and {@link readState} waits out the half-written state.
 */
function writeState(path, text) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path, text)
    return
  }
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, path)
}

/**
 * The state, parsed. One that does not parse (half written, on Windows) is read again until the budget is spent; a missing file is an
 * error at once. `pause` and `now` are the wait between tries and the clock, for a test to stand in for.
 */
function readState(path, { pause = () => wait(20), now = Date.now } = {}) {
  const end = now() + READ_BUDGET_MS
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT' || now() > end) throw e
      pause()
    }
  }
}

module.exports = { readState, writeState }
