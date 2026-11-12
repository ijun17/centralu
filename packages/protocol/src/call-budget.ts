/**
 * How long a call may take, declared once (#2170). The window's client (`RpcClient`) waits this long for the host, and the
 * hub waits the same for a linked machine when it forwards the window's call (`Router`): before, the hub cut every
 * forwarded call at one flat 200 s, which ended a git commit with a slow hook, or an app call waiting on the person's
 * answer, while the machine still ran it, and left a short call waiting long after the window had given up.
 *
 * Data only. No frame carries a budget: each build reads this table for itself, so an older hub or window keeps its own
 * numbers and works with a newer one.
 */

/** How long an open socket may go without `hello_ok` before it is dropped and retried */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** The default response time. Session creation and git reads also finish within this (measured at a few seconds) */
export const DEFAULT_CALL_BUDGET_MS = 30_000

/**
 * What the host gives a git write the person asked for (stage, commit, switch, push): they run the repository's hooks
 * (a pre-commit type check, a pre-push test run) and the credential helper, which may wait on a sign-in. A clone has the
 * same bound.
 */
export const GIT_WRITE_TIMEOUT_MS = 10 * 60_000

/** How long the host waits for the person to answer an app's first use of a capability */
export const APP_CAPABILITY_QUESTION_MS = 5 * 60_000

/** How long the host waits for an app to answer one call (reset by its progress notifications) */
export const APP_CALL_TIMEOUT_MS = 10 * 60_000

/**
 * Calls that **can revive a session** (dogfooding: a "resource upload" session — codex's thread/resume rereads its whole
 * rollout file, and a 550MB thread took 13.5 seconds, with larger threads going over 25. Under the 30-second default, a
 * large thread becomes a session that can never wake up). Since the file only ever grows, the cap has to be a value that
 * can scale with size — 180 seconds covers up to the 7GB class at the measured ratio. The manager's own stage limit
 * (150 seconds) sits inside this, so even when time runs out, a named reason reaches the screen.
 */
const LONG_CALL_BUDGET_MS = 180_000
const LONG_CALLS: ReadonlySet<string> = new Set([
  'agents.resumeSession', // An explicit wake-up
  'agents.send', // If the session is asleep, revives it first, then sends — pays the same cost
  'agents.createSession', // When picking up a previous conversation via resumeExternalId
  'agents.restartSession', // Swaps out the process and revives it again
  'agents.exportHandoffRecord', // Can scan a rollout hundreds of MB in size (#78)
  /*
   * Calls that end in a revival (#164) — while these were missing here, the host would apply and restart on a large
   * conversation, but the screen showed "RPC timed out" (reading what succeeded as a failure). Add a new RPC that ends
   * in a revival here too.
   */
  'agents.updateSettings', // Swaps out the process if a resting session's settings change (restartSession)
  'agents.forkConversation', // Revives as a forked copy
  'machines.update', // Installs beside and waits for the sessions there to finish (#1399); a wait that outlasts it is the row's to show
  'agents.resolveMcpProposal', // Restarts the Assistant on approval
  'agents.resolveSkillProposal', // Same
  'agents.deleteOrchestratorSkill', // Same
  'agents.deleteAssistantSkill', // Same
  // A new project can be a clone (#515), which takes as long as the repository does; past this budget the screen says it is still cloning
  'projects.create',
])

/**
 * A git write gets a budget past the host's own (#982 review): under the 30-second default the screen said "RPC timed
 * out" while git still held `index.lock`, unlocked its buttons, and a second click started a second commit. Past the
 * host's, the screen hears the host's own answer, a timeout included.
 */
const GIT_WRITE_BUDGET_MS = GIT_WRITE_TIMEOUT_MS + 60_000
const GIT_WRITE_CALLS: ReadonlySet<string> = new Set(['git.stage', 'git.commit', 'git.checkout', 'git.push'])

/**
 * An app tool a screen calls (`apps.invoke`, M4 D-4) can wait on a person — the first time an app uses a capability the
 * host asks the app's pinned screen and waits for an answer — and then the app may run for its own bound. Both fit in
 * the budget, or the screen's call would cut off while the person is still reading and answering.
 */
const APP_CALL_BUDGET_MS = APP_CAPABILITY_QUESTION_MS + APP_CALL_TIMEOUT_MS

/** How long a call to the host waits for its answer before it is cut */
export function callBudgetMs(method: string): number {
  if (method === 'apps.invoke') return APP_CALL_BUDGET_MS
  if (GIT_WRITE_CALLS.has(method)) return GIT_WRITE_BUDGET_MS
  return LONG_CALLS.has(method) ? LONG_CALL_BUDGET_MS : DEFAULT_CALL_BUDGET_MS
}
