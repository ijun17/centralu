import { RpcMethods, parseRpcResult, type RpcMethodName, type RpcParams, type RpcResult } from '@cc/protocol'

/**
 * The window's RPC as the router answers it (`Router.handle`, main.ts): what the orchestrator's commands for settings
 * and the trash call (#1219), so each makes the call the window makes, with the checks the window's call meets: the
 * method's own schema, the router's routing to a linked machine, and the host's handler.
 */
export type WindowRpc = (method: string, params: unknown, ctx?: { client: number; rights?: 'full' | 'limited'; label?: string | null }) => Promise<unknown>

/**
 * The methods the orchestrator's settings and trash commands may call, and no others. A list, not "any method": the
 * orchestrator reaches what #1219's inventory (docs/agent-host.md §1.4) marks as its own, and a method added to the
 * protocol is not reachable from here until it is named in a change that says why.
 */
export const WINDOW_METHODS = [
  'prefs.get',
  'prefs.set',
  'themes.list',
  'agents.sleepPolicy',
  'agents.setSleepPolicy',
  'updates.status',
  'updates.setAuto',
  'updates.setAutoApply',
  'agents.versions',
  'agents.setAutoApplyVersions',
  'agents.applyVersions',
  'trash.list',
  'trash.restore',
  'trash.restoreSubagentSteps',
  'subagents.usage',
  'subagents.trash',
  'agents.deleteSession',
  'trash.purge',
  'trash.purgeSubagentSteps',
  'trash.purgeRuns',
  'projects.list',
  'projects.setTrusted',
  'apps.list',
  'machines.list',
  'approvals.rules',
  'approvals.deleteRule',
  'sessions.list',
  'apps.permissions',
  'apps.forgetPermission',
  'projectConsents.list',
  'projectConsents.revoke',
  'apps.setShared',
  'sessions.rename',
  'agents.clearBackgroundTasks',
  'agents.detect',
  'agents.usage',
  'agents.models',
  'projects.gitStatus',
  'projects.origin',
  'files.search',
  'apps.remove',
  'apps.restart',
  'apps.versions',
  'apps.restoreVersion',
  'apps.check',
  'apps.runs',
  'apps.errors',
  'apps.usage',
] as const satisfies readonly RpcMethodName[]

export type WindowMethod = (typeof WINDOW_METHODS)[number]

/** A schema's complaints, one per argument, as a sentence */
export function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(value)'}: ${i.message}`).join('; ')
}

/**
 * One call of the window's RPC: the params through the method's schema (a refusal reads as the schema's complaint, not
 * as a raised error), the answer through its result schema so a field an older host never sent has its default.
 */
export async function callWindow<M extends WindowMethod>(rpc: WindowRpc, method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  if (!(WINDOW_METHODS as readonly string[]).includes(method)) throw new Error(`${method} is not one of the methods the orchestrator calls`)
  const checked = RpcMethods[method].params.safeParse(params)
  if (!checked.success) throw new Error(issuesOf(checked.error))
  return parseRpcResult(method, await rpc(method, checked.data))
}
