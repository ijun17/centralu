import { z } from 'zod'

/**
 * `host.lock`'s `store`: the host works on its store and answers no one (docs/agent-host/remote/serve.md, #2334).
 * Pinned by `tooling/fixtures/host-lock-store-work.json`; the launcher, without this package, reads it itself
 * (`parseStoreWork`, its words held to `storeWorkWords` by a test).
 */
export const StoreWork = z.object({
  doing: z.enum(['copy', 'update']),
  /** The step the copy is made before, or the step running */
  step: z.number().int(),
  /** The store with its WAL */
  bytes: z.number().nonnegative(),
  /** Epoch ms; for an update, the first step's start */
  since: z.number(),
})
export type StoreWork = z.infer<typeof StoreWork>

export function storeWorkOf(raw: unknown): StoreWork | null {
  const r = StoreWork.safeParse(raw)
  return r.success ? r.data : null
}

/** One wording for every surface; `whose` for one with no subject before it ("Centralu's") */
export function storeWorkWords(work: Pick<StoreWork, 'doing'>, whose = 'its'): string {
  return work.doing === 'copy' ? `copying ${whose} data before an update` : `updating ${whose} data for the new version`
}
