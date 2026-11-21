/* Bounds on stopping a process tree, read by kill-tree.ts and run.ts; no imports, so the in-memory OS reads them without the real stop */

/**
 * How long a stop waits for the process table, read while the tree runs. The warm reader takes 2–4 ms (p99, #2178); its first
 * start takes 0.3 s idle and 2 s under load, and a read in a PowerShell of its own 0.4–1 s, 9–12 s on a starved machine (#1773).
 * Past the bound the stop takes `taskkill /T`, in no order, which still ends the tree
 */
export const STOP_LIST_MS = 3000

export const TASKKILL_MS = 5000

/**
 * How long the host's shutdown waits for the stops it started (`stopsSettled`), under `SHUTDOWN_BOUND_MS`. A stop that could not
 * read the table takes one read and one `taskkill` per root side by side, and a second to spare; one that read it takes one
 * `taskkill` per process of the longest tree in turn (0.2–0.5 s each, measured), which a starved machine does not fit. Past the
 * bound the shutdown goes on, and a tree the stop did not reach is beyond what the host can still do
 */
export const STOPS_SETTLE_MS = STOP_LIST_MS + TASKKILL_MS + 1000
