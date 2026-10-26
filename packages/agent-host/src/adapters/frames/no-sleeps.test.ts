import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * The tests of the frame-replayed adapters wait for an event or a frame, never for time (#1498: tests that wait on
 * wall-clock time fail under load). A test that needs a timer is a test that guesses how long the tool takes.
 */
const ADAPTERS = fileURLToPath(new URL('..', import.meta.url))
const GUARDED = ['acp', 'frames', 'cursor-agent']
const SLEEP = /\bsetTimeout\s*\(|\bsleep\s*\(|\bdelay\s*\(|waitForTimeout|vi\.advanceTimers/

it('no test of the frame-replayed adapters sleeps', () => {
  const offenders = GUARDED.flatMap((dir) =>
    readdirSync(join(ADAPTERS, dir))
      .filter((f) => f.endsWith('.test.ts') && f !== 'no-sleeps.test.ts')
      .flatMap((f) =>
        readFileSync(join(ADAPTERS, dir, f), 'utf8')
          .split('\n')
          .flatMap((line, i) => (SLEEP.test(line) ? [`${dir}/${f}:${i + 1}: ${line.trim()}`] : [])),
      ),
  )
  expect(offenders).toEqual([])
})
