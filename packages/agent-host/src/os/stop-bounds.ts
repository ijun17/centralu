/*
 * How long a tree stop is given, read by the stop itself (kill-tree.ts) and by a run that waits for one (run.ts). Here,
 * with no imports, so the in-memory OS can read them without loading the real process stopping.
 */

/**
 * How long a stop waits for the process table (#2142 re-check): it is read while the tree runs, so a stop waits for it.
 * From the warm reader a read takes 2–4 ms, with every core busy too (p99, #2178); this bound is for the reader's first start
 * (0.3 s idle, 2 s with every core busy) and for a read in a PowerShell of its own, which took 0.4–1 s, and 9–12 s on a starved
 * machine (#1773). The stop is given up on it and takes `taskkill /T`, in no order, which is what then ends the tree
 */
export const STOP_LIST_MS = 3000

/** How long a `taskkill` is given before it is given up on */
export const TASKKILL_MS = 5000

/**
 * How long the host's shutdown waits for the stops it started (`stopsSettled`), under the host's own bound (`SHUTDOWN_BOUND_MS`).
 * A stop that could not read the table is a table read (`STOP_LIST_MS`) and one `taskkill` for every root side by side (`TASKKILL_MS` at
 * most), and a second to spare. One that read it is the read, one `taskkill` for the roots, and one for each process of the longest
 * tree after the one before it, and a read of the table before each (the warm reader's 2–4 ms; a read of its own, before it is warm, 0.4–1 s,
 * and bounded by `TASKKILL_MS`, #2206), which a tree of a few processes fits (0.2–0.5 s each, measured), and which a starved machine
 * does not: the table then is what fails first. Past the bound the shutdown goes on, and a tree the stop did not reach is the
 * one thing the host can no longer do anything about.
 */
export const STOPS_SETTLE_MS = STOP_LIST_MS + TASKKILL_MS + 1000
