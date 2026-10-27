import type { RpcMethodName, RpcResult } from './commands.js'
import { appsResults } from './commands/methods/apps.results.js'
import { hostResults } from './commands/methods/host.results.js'
import { mailResults } from './commands/methods/mail.results.js'
import { orchestratorResults } from './commands/methods/orchestrator.results.js'
import { projectsResults } from './commands/methods/projects.results.js'
import { sessionsResults } from './commands/methods/sessions.results.js'
import { settingsResults } from './commands/methods/settings.results.js'
import { terminalResults } from './commands/methods/terminal.results.js'
import { parseTolerant } from './tolerant.js'

/**
 * Every method's result schema, and none of their parameters: what a client needs to read an answer. The parameters are
 * the host's to validate and live beside them in `RpcMethods` (commands.ts), which the UI's bundle does not carry (#1648).
 */
const RpcResults = {
  ...sessionsResults,
  ...orchestratorResults,
  ...projectsResults,
  ...terminalResults,
  ...appsResults,
  ...hostResults,
  ...mailResults,
  ...settingsResults,
}

/**
 * A host's answer to `method`, as the receiving client holds it: through the method's result schema, so every field
 * the protocol added with a default has that default even when an older host never sent it (#280 lets a window
 * attach to an older host). Tolerant, not strict — see `parseTolerant`. Call it once, at the client's boundary.
 */
export function parseRpcResult<M extends RpcMethodName>(method: M, raw: unknown): RpcResult<M>
export function parseRpcResult(method: RpcMethodName, raw: unknown): unknown {
  return parseTolerant(RpcResults[method], raw)
}
