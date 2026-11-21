import type { RpcMethodName, RpcResult } from './commands.js'
import { appsResults } from './commands/methods/apps.results.js'
import { hostResults } from './commands/methods/host.results.js'
import { mailResults } from './commands/methods/mail.results.js'
import { assistantResults } from './commands/methods/assistant.results.js'
import { projectsResults } from './commands/methods/projects.results.js'
import { sessionsResults } from './commands/methods/sessions.results.js'
import { settingsResults } from './commands/methods/settings.results.js'
import { terminalResults } from './commands/methods/terminal.results.js'
import { parseTolerant } from './tolerant.js'

/** Results without parameters: the parameters are the host's to validate (`RpcMethods`), kept out of the UI's bundle (#1648) */
const RpcResults = {
  ...sessionsResults,
  ...assistantResults,
  ...projectsResults,
  ...terminalResults,
  ...appsResults,
  ...hostResults,
  ...mailResults,
  ...settingsResults,
}

/** Once, at the client's boundary, so an older host's answer gets the defaults (docs/protocol.md §4) */
export function parseRpcResult<M extends RpcMethodName>(method: M, raw: unknown): RpcResult<M>
export function parseRpcResult(method: RpcMethodName, raw: unknown): unknown {
  return parseTolerant(RpcResults[method], raw)
}
