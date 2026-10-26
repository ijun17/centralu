/**
 * What the `guard/*` lint rules (tooling/eslint-guards.js) let through, by rule and file, each with its reason (#1606).
 *
 * A guard that used to be a test had its exemptions in the test; they are here so that one list says what is
 * let through and why. No comment switches these rules off (they run in a pass that reads no comment as configuration,
 * tooling/eslint-guard-pass.js): a real exception is a line below.
 *
 * An entry says, for one file:
 *   - `reason`: why it stays. Required.
 *   - `count`: how many findings the file may hold. More fails, and fewer fails too (the line is lowered with the
 *     change that removes a site), so the list never says more than is true.
 *   - `counts`: how many findings of each kind (by the text the rule gives it: a callee, a class) the file may hold. A kind
 *     that is not listed, one more than listed, and one fewer than listed all fail: a second identical call is not let through
 *     by the first one's line.
 *   - none of these: every finding of the rule in that file.
 *
 * The list only shrinks: tooling/guards-checks.test.ts holds a ceiling on its size, and that every file listed is
 * a file in the repository.
 */
export const EXCEPTIONS = {
  'no-hand-split': {
    'packages/protocol/src/paths.ts': {
      reason: 'The one file allowed to write the separator down, because writing it down is its subject: every other file asks it (wireSegments, wireBaseName, wireJoin)',
    },
  },
  'git-start': {
    'packages/agent-host/src/dev-services/git-exec.ts': {
      reason: 'The one place that starts git (runGit): every other file goes through it, so a new call is locked before trust by default (#407)',
    },
    'packages/agent-host/src/links/remote-install.mjs': {
      reason: "Runs on another machine, on its own Node, and imports nothing of the host: a dev build there checks the maintainer's working copy with the git on that machine's PATH (#1036, devBuild)",
    },
  },
  'no-hand-coded-error': {
    'packages/agent-host/src/rpc-error.ts': {
      reason: 'rpcError builds the host\'s coded errors: the one place that assembles one (#850)',
    },
    'packages/platform/src/mock/mock-error.ts': {
      reason: 'mockError builds the mock\'s coded errors, typed by the protocol: the one place that assembles one (#850 item 14)',
    },
  },
  'purge-callers': {
    'packages/agent-host/src/rpc.ts': {
      counts: { 'mgr.emptyTrash': 1, 'mgr.purgeSession': 1 },
      reason: 'The RPC handler: only the person deletes for good, and only through the RPC (#204)',
    },
    'packages/agent-host/src/sessions/app-sessions.ts': {
      counts: { 'this.host.purgeSession': 1 },
      reason: 'The one deletion the host makes itself (#378): a finished app-agent session, once its record is kept in the session archive. It reaches the purge only through agentRunEnded after a clean run (app-agents.test.ts holds when it does and when the session stays)',
    },
    'packages/agent-host/src/sessions/manager.ts': {
      counts: { 'self.purgeSession': 1, 'this.trash.emptyTrash': 1, 'this.trash.purgeSession': 1 },
      reason: "The manager hands app-sessions the same purge, and passes the two calls on to its session archive (session-trash.ts, #428); the same calls, not other callers",
    },
    'packages/agent-host/src/sessions/session-trash.ts': {
      counts: { 'this.host.store.trash.purgeSession': 1, 'this.purgeSession': 1 },
      reason: 'emptyTrash purges one by one; purgeSession removes the rows through the store',
    },
  },
  'subagent-purge-callers': {
    'packages/agent-host/src/rpc.ts': {
      counts: { 'mgr.purgeSubagentSteps': 1 },
      reason: 'The RPC handler: only the person deletes subagent steps for good, and only through the RPC (#204)',
    },
    'packages/agent-host/src/sessions/manager.ts': {
      counts: { 'this.trash.purgeSubagentSteps': 1 },
      reason: 'Deleting all archived sessions purges their steps too; the manager passes the call on to the session archive',
    },
    'packages/agent-host/src/sessions/session-trash.ts': {
      counts: { 'this.host.store.subagentSteps.purge': 1 },
      reason: 'The session archive removes the steps through the store',
    },
  },
  'ui-type-scale': {
    'packages/ui/src/features/viewer/CodeViewer.tsx': {
      counts: { 'leading-[18px]': 1 },
      reason: "The virtual list's row height: a line height the list's arithmetic depends on",
    },
    'packages/ui/src/features/git/GitPanel.tsx': {
      counts: { 'leading-[1.5]': 1 },
      reason: "The diff's virtual list's ~17px rows depend on it",
    },
  },
  'ui-radius-scale': {
    'packages/ui/src/features/session/SessionView.tsx': {
      count: 1,
      reason: "the folded composer inside the pane's 1px border: the panel corner less the border, a calc on the token",
    },
    'packages/ui/src/features/pinned-app/PinnedApps.tsx': {
      count: 1,
      reason: 'the same folded composer under a pinned app: the panel corner less the border, a calc on the token',
    },
    'apps/web/src/harness/shell-banner.tsx': {
      count: 1,
      reason: "the browser harness draws macOS's traffic lights as circles; not a screen of the app",
    },
  },
}
