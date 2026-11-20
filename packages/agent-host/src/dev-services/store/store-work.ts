/**
 * What a starting host does to its store before it can answer (#2334): writing the copy before a step that breaks
 * older readers (`copy`, store/store-copy.ts), or running store steps (`update`). Both are synchronous SQLite work
 * that can take minutes on a large store, and the host cannot answer anyone meanwhile.
 *
 * Said in `host.lock` (dev-services/instance-lock.ts), the file every starter already reads to know who holds the
 * folder, so the window, `serve --detach`, the update switch and `serve --stop` all read one record with one identity
 * check, and wait while the host that holds the folder says it is busy instead of taking it for a hung start.
 * `step` is the step the copy is made before, or the step running; `bytes` the store with its WAL; `since` when the
 * work began, in epoch milliseconds (for an update, the first step's start, not each step's).
 */
export type StoreWork = { doing: 'copy' | 'update'; step: number; bytes: number; since: number }

/** Where the store's work is said: the lock's description, or nowhere (a store in memory, a test) */
export type SayStoreWork = (work: StoreWork | null) => void
