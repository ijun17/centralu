import type { z } from 'zod'
import { appMethods } from './commands/methods/apps.js'
import { hostMethods } from './commands/methods/host.js'
import { mailMethods } from './commands/methods/mail.js'
import { orchestratorMethods } from './commands/methods/orchestrator.js'
import { projectMethods } from './commands/methods/projects.js'
import { sessionMethods } from './commands/methods/sessions.js'
import { settingsMethods } from './commands/methods/settings.js'
import { terminalMethods } from './commands/methods/terminal.js'
import { parseTolerant } from './tolerant.js'

/** UI → host RPC. Maps one-to-one to the port interface (platform/ports) (docs/protocol.md §3) */

export * from './commands/sessions.js'
export * from './commands/projects.js'
export * from './commands/files.js'

/*
 * One module per concept under commands/methods/ (#850), spread together here. Only the key order follows from the
 * spread: what reads it in order (`scripts/smoke-schemas.mts`) still calls every key. The shapes the methods carry live
 * in commands/ and entities/.
 */
export const RpcMethods = {
  ...sessionMethods,
  ...orchestratorMethods,
  ...projectMethods,
  ...terminalMethods,
  ...appMethods,
  ...hostMethods,
  ...mailMethods,
  ...settingsMethods,
} as const

export type RpcMethodName = keyof typeof RpcMethods

/**
 * What the **sender** has to provide (`z.input`).
 *
 * Why not the output type: a field with `.default()` is filled in by the parser, so the caller
 * is allowed to omit it. Collapsing the two into one produces spots like `files.search`'s
 * `limit` that insist on being required when they are actually optional — this actually
 * happened once.
 */
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]['params']>

/** What the **receiver** holds in hand (`z.output`) — after defaults have been filled in */
export type RpcResult<M extends RpcMethodName> = z.output<(typeof RpcMethods)[M]['result']>

/**
 * A host's answer to `method`, as the receiving client holds it: through the method's result schema, so every field
 * the protocol added with a default has that default even when an older host never sent it (#280 lets a window
 * attach to an older host). Tolerant, not strict — see `parseTolerant`. Call it once, at the client's boundary.
 */
export function parseRpcResult<M extends RpcMethodName>(method: M, raw: unknown): RpcResult<M>
export function parseRpcResult(method: RpcMethodName, raw: unknown): unknown {
  return parseTolerant(RpcMethods[method].result, raw)
}
