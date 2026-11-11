import { afterAll, beforeAll } from 'vitest'
import { stopProcessTable, warmProcessTable } from './kill-tree.js'

/**
 * Gives this test file's stops the warm process-table reader a host has (#2178): a file whose tests end real process
 * trees reads the table on Windows, and without the reader every read is a PowerShell of its own, which a busy CI runner
 * took more than the 3 s a stop waits to start. Only these files keep one, not every test worker. Nothing on POSIX.
 */
export function useWarmProcessTable(): void {
  beforeAll(() => warmProcessTable())
  afterAll(() => stopProcessTable())
}
