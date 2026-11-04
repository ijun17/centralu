import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

/*
 * Run only by tooling/vitest-data-dir.test.ts, in a vitest of its own (CC_LEAK_PROBE=1): a test that makes temporary
 * folders the way tests do and removes none of them.
 */
it.runIf(process.env.CC_LEAK_PROBE === '1')('leaves folders in the temporary folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-leaked-'))
  mkdirSync(join(dir, 'deep'))
  writeFileSync(join(dir, 'deep', 'file'), 'left')
  mkdtempSync(join(tmpdir(), 'cc-leaked-empty-'))
})
