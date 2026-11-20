import type { StoreWork } from '@cc/protocol'

/**
 * Where an open says what it does to the store while the host cannot answer (`StoreWork`, @cc/protocol, #2334): the
 * lock's description (dev-services/instance-lock.ts `sayWork`), or nowhere (a store in memory, a test). null: done.
 */
export type SayStoreWork = (work: StoreWork | null) => void
