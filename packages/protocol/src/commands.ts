import type { z } from 'zod'
import { appMethods } from './commands/methods/apps.js'
import { hostMethods } from './commands/methods/host.js'
import { mailMethods } from './commands/methods/mail.js'
import { assistantMethods } from './commands/methods/assistant.js'
import { projectMethods } from './commands/methods/projects.js'
import { sessionMethods } from './commands/methods/sessions.js'
import { settingsMethods } from './commands/methods/settings.js'
import { terminalMethods } from './commands/methods/terminal.js'

/** UI → host RPC. Maps one-to-one to the port interface (platform/ports) (docs/protocol.md §3) */

export * from './commands/sessions.js'
export * from './commands/projects.js'
export * from './commands/files.js'
export * from './commands/session-params.js'

// One module per concept under commands/methods/; the spread fixes only the key order, and
// `scripts/smoke-schemas.mts`, which reads in order, still calls every key
export const RpcMethods = {
  ...sessionMethods,
  ...assistantMethods,
  ...projectMethods,
  ...terminalMethods,
  ...appMethods,
  ...hostMethods,
  ...mailMethods,
  ...settingsMethods,
} as const

export type RpcMethodName = keyof typeof RpcMethods

/** What the sender provides (`z.input`): the parser fills a `.default()` field, so the caller may omit it */
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]['params']>

/** What the receiver holds (`z.output`), defaults filled in */
export type RpcResult<M extends RpcMethodName> = z.output<(typeof RpcMethods)[M]['result']>
