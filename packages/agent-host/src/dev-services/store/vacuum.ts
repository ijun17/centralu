/**
 * How much free space in the file is worth a vacuum at startup (v40). Below this the pages stay in the file for later
 * writes to reuse; a vacuum rewrites the whole file, which is not worth it for a few megabytes.
 */
export const VACUUM_FREE_BYTES = 16 * 1024 * 1024

/** What an owed `VACUUM` did: the file's size before and after, and how long it took */
export type VacuumDone = { before: number; after: number; ms: number }

export const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)}MB`
