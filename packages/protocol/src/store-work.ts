import { z } from 'zod'

/**
 * What a starting host does to its store before it can answer (#2334): writing the copy before a step that breaks older
 * readers (`copy`), or running store steps (`update`). Both are synchronous SQLite work that can take minutes on a large
 * store, and the host cannot answer anyone meanwhile.
 *
 * The host says it in `host.lock`'s `store` (agent-host `dev-services/instance-lock.ts`), the record every starter
 * already reads: the window (through the shell's `host_store_work`), `centralu serve --detach`, `--connection` (as
 * `starting`), the update switch and `--stop`, and a hub through its link. `step` is the step the copy is made before, or
 * the step running; `bytes` the store with its WAL; `since` when the work began, in epoch milliseconds (for an update, the
 * first step's start). The record's bytes are pinned by `tooling/fixtures/host-lock-store-work.json`, which every reader's
 * tests read. The npm launcher, which ships without this package, reads it with `parseStoreWork` (serve-files.mjs), whose
 * wording a test holds to `storeWorkWords`.
 */
export const StoreWork = z.object({
  doing: z.enum(['copy', 'update']),
  step: z.number().int(),
  bytes: z.number().nonnegative(),
  since: z.number(),
})
export type StoreWork = z.infer<typeof StoreWork>

/** The store work in `raw`, or null when it is not one this build knows */
export function storeWorkOf(raw: unknown): StoreWork | null {
  const r = StoreWork.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * What the host is doing, in the words every surface uses for it (one state, one wording): "copying its data before an
 * update". `whose` names the data for a surface that has no subject before it ("Centralu's"). No step number: it means
 * nothing to the person, and host.log has it.
 */
export function storeWorkWords(work: Pick<StoreWork, 'doing'>, whose = 'its'): string {
  return work.doing === 'copy' ? `copying ${whose} data before an update` : `updating ${whose} data for the new version`
}
