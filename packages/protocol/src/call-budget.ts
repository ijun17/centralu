// How long a call may take, read by the window's `RpcClient` and by the hub forwarding it to a linked machine
// (docs/agent-host/remote/hub-links.md "How long a forwarded call waits"). No frame carries a budget.

/** Without `hello_ok` by then, the socket is dropped and retried */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** Session creation and git reads finish well within it (measured at a few seconds) */
export const DEFAULT_CALL_BUDGET_MS = 30_000

/** A git write or a clone runs the repository's hooks and the credential helper, which may wait on a sign-in */
export const GIT_WRITE_TIMEOUT_MS = 10 * 60_000

/** For the person to answer an app's first use of a capability */
export const APP_CAPABILITY_QUESTION_MS = 5 * 60_000

/** For an app to answer one call; reset by its progress notifications */
export const APP_CALL_TIMEOUT_MS = 10 * 60_000

/**
 * Calls that can revive a session: Codex's thread/resume rereads the whole rollout (550 MB took 13.5 s, larger ones
 * over 25 s), which only grows; 180 s covers the 7 GB class at that ratio. The manager's 150 s stage limit sits inside,
 * so a named reason reaches the screen.
 */
const LONG_CALL_BUDGET_MS = 180_000
const LONG_CALLS: ReadonlySet<string> = new Set([
  'agents.resumeSession', // An explicit wake-up
  'agents.send', // If the session is asleep, revives it first, then sends — pays the same cost
  'agents.createSession', // When picking up a previous conversation via resumeExternalId
  'agents.restartSession', // Swaps out the process and revives it again
  'agents.exportHandoffRecord', // Can scan a rollout hundreds of MB in size (#78)
  // Calls that end in a revival (#164); outside this set the screen says "RPC timed out" on a success
  'agents.updateSettings', // Swaps out the process if a resting session's settings change (restartSession)
  'agents.forkConversation', // Revives as a forked copy
  'machines.update', // Installs beside and waits for the sessions there to finish (#1399); a wait that outlasts it is the row's to show
  'agents.resolveMcpProposal', // Restarts the Assistant on approval
  'agents.resolveSkillProposal', // Same
  'agents.deleteOrchestratorSkill', // Same
  'agents.deleteAssistantSkill', // Same
  // A clone takes as long as the repository does; past this budget the screen says it is still cloning
  'projects.create',
])

/**
 * Past the host's own limit, so the screen hears the host's answer: cut earlier, it unlocked its buttons while git still
 * held `index.lock`, and a second click started a second commit (#982)
 */
const GIT_WRITE_BUDGET_MS = GIT_WRITE_TIMEOUT_MS + 60_000
const GIT_WRITE_CALLS: ReadonlySet<string> = new Set(['git.stage', 'git.commit', 'git.checkout', 'git.push'])

/** `apps.invoke` may wait on the person's capability answer, then on the app's own bound */
const APP_CALL_BUDGET_MS = APP_CAPABILITY_QUESTION_MS + APP_CALL_TIMEOUT_MS

/** Past the host's 15-minute host-request lifetime (`HOST_REQUEST_LIMITS.lifetimeMs`), so the host's expiry arrives before client timeout */
const HOST_REQUEST_BUDGET_MS = 15 * 60_000 + 60_000

export function callBudgetMs(method: string): number {
  if (method === 'host.trustDevTab') return HOST_REQUEST_BUDGET_MS
  if (method === 'apps.invoke') return APP_CALL_BUDGET_MS
  if (GIT_WRITE_CALLS.has(method)) return GIT_WRITE_BUDGET_MS
  return LONG_CALLS.has(method) ? LONG_CALL_BUDGET_MS : DEFAULT_CALL_BUDGET_MS
}
