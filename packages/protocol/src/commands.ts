import type { z } from 'zod'
import { appMethods } from './commands/methods/apps.js'
import { gateMethods } from './commands/methods/gate.js'
import { hostMethods } from './commands/methods/host.js'
import { mailMethods } from './commands/methods/mail.js'
import { orchestratorMethods } from './commands/methods/orchestrator.js'
import { projectMethods } from './commands/methods/projects.js'
import { sessionMethods } from './commands/methods/sessions.js'
import { settingsMethods } from './commands/methods/settings.js'
import { terminalMethods } from './commands/methods/terminal.js'

/** UI → host RPC. Maps one-to-one to the port interface (platform/ports) (docs/protocol.md §3) */

export * from './commands/sessions.js'
export * from './commands/projects.js'
export * from './commands/files.js'
export * from './commands/session-params.js'
export { GATE_DECISION_FIELDS } from './commands/methods/gate.params.js'

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
  ...gateMethods,
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
