/**
 * What the `guard/*` lint rules (tooling/eslint-guards.js) let through, by rule and file, each with its reason (#1606).
 *
 * A guard that used to be a test had its exemptions in the test; they are here so that one list says what is
 * let through and why. No comment switches these rules off (they run in a pass that reads no comment as configuration,
 * tooling/eslint-guard-pass.js): a real exception is a line below.
 *
 * An entry says, for one file:
 *   - `reason`: why it stays. Required (a text, or one per kind with `counts`).
 *   - `count`: how many findings the file may hold. More fails, and fewer fails too (the line is lowered with the
 *     change that removes a site), so the list never says more than is true.
 *   - `counts`: how many findings of each kind (by the text the rule gives it: a callee, a class) the file may hold, with a `reason`
 *     for each kind where `reason` is a map. A kind
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
  'hand-made-looks': {
    'packages/ui/src/features/approval/QuestionCard.tsx': {
      counts: { button: 3, capsule: 1 },
      reason: {
        button: "answer options are selectable cards lit by a white edge, and Answer is #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these",
        capsule: "Answer, #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these",
      },
    },
    'packages/ui/src/features/onboarding/Intro.tsx': {
      counts: { button: 1 },
      reason: {
        button: "a tool card of the first run, large and two-lined",
      },
    },
    'packages/ui/src/features/orchestrator/OrchestratorView.tsx': {
      counts: { button: 3 },
      reason: {
        button: "two approve buttons brighter than primary on purpose (a proposal waits on the person), and the suggestion tiles",
      },
    },
    'packages/ui/src/features/palette/SearchField.tsx': {
      counts: { button: 1 },
      reason: {
        button: "the search box of the top bar, a button shaped as a field",
      },
    },
    'packages/ui/src/features/sidebar/GridButton.tsx': {
      counts: { button: 1 },
      reason: {
        button: "a sidebar navigation tile (rounded-lg), lit while its screen is open",
      },
    },
    'packages/ui/src/features/sidebar/OrchestratorButton.tsx': {
      counts: { button: 1 },
      reason: {
        button: "a sidebar navigation tile (rounded-lg), lit while its screen is open",
      },
    },
    'packages/ui/src/features/session/chat-stream/StickyUser.tsx': {
      counts: { button: 2 },
      reason: {
        button: "the pinned user message, a message bubble that opens when pressed",
      },
    },
    'packages/ui/src/features/approval/RowApproval.tsx': {
      counts: { button: 3, capsule: 3 },
      reason: {
        button: "Allow / Deny / Open with a key hint, #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these; sized to a slot the row measures its fit against",
        capsule: "the same three answers, #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these",
      },
    },
    'packages/ui/src/features/inbox/Inbox.tsx': {
      counts: { button: 2, capsule: 2 },
      reason: {
        button: "a waiting row's answers, #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these",
        capsule: "the same two answers, #1160's capsule action (owner, 2026-10-18); Button has no capsule shape yet, the next step for these",
      },
    },
    'packages/ui/src/features/inbox/InboxPill.tsx': {
      counts: { button: 1, capsule: 1 },
      reason: {
        button: "the inbox capsule: its peek line grows out of it with no flex gap and its own line heights (measured offsets), which Pill's bar size sets",
        capsule: "the inbox capsule, as above",
      },
    },
    'packages/ui/src/features/session/BackgroundTasks.tsx': {
      counts: { button: 1, capsule: 3 },
      reason: {
        button: "the background work capsule: 24px, its edge and ink follow running, ended and failed work",
        capsule: "the background work capsule, and two status dots (a ring and a dashed ring), not capsules",
      },
    },
    'packages/ui/src/features/session/SessionSettings.tsx': {
      counts: { button: 1, capsule: 1 },
      reason: {
        button: "the session's model and permission menu trigger, a capsule held lit while its menu is open",
        capsule: "the same trigger",
      },
    },
    'packages/ui/src/features/session/SessionStart.tsx': {
      counts: { capsule: 1 },
      reason: {
        capsule: "#1160's segmented tool switch (owner, 2026-10-18): options without frames inside one capsule, holding a loading placeholder; Segmented frames each option",
      },
    },
    'packages/ui/src/features/session/chat-rows/CentraluCall.tsx': {
      counts: { button: 1, capsule: 1 },
      reason: {
        button: "the session a Centralu call reached, a 24px chip that opens it",
        capsule: "the same chip",
      },
    },
    'packages/ui/src/features/usage/UsageDonuts.tsx': {
      counts: { capsule: 1 },
      reason: {
        capsule: "a linked machine's donuts, drawn by an outline only (owner, 2026-10-18)",
      },
    },
    'packages/ui/src/features/machines/MachineTag.tsx': {
      counts: { button: 1 },
      reason: {
        button: "the machine badge, a chip whose solid or dashed edge says whether the link is up",
      },
    },
    'packages/ui/src/features/project/NewSessionDialog.tsx': {
      counts: { button: 1 },
      reason: {
        button: "pick-several chips of the files to copy, not one of several",
      },
    },
    'packages/ui/src/features/settings/MachinesSection.tsx': {
      counts: { button: 1 },
      reason: {
        button: "the uninstall confirmation: a plain frame in danger ink; the danger variant would add its fill",
      },
    },
    'packages/ui/src/features/settings/TypographySection.tsx': {
      counts: { button: 1 },
      reason: {
        button: "text size steps: each shows its own size, larger than any Segmented size",
      },
    },
    'packages/ui/src/features/settings/AddMachineForm.tsx': {
      counts: { button: 1 },
      reason: {
        button: "the ssh hosts list: pressing the picked host asks it again, which Segmented (a press on the picked option does nothing) cannot do",
      },
    },
  },
}

/**
 * Where the word "trash" is still said, for `guard/archive-wording` (#1404, #1607): `file` matches the path of a file, `text` the part of a text there that is allowed to say it
 * (the rest of the text is still checked), and `why` is the reason. `pnpm lint` fails on an entry that no file of the whole run used (tooling/lint.ts,
 * `guard/archive-allowed-used`): the file an `own` entry (one for a single file) was for is renamed or gone, or stopped saying it. A many-file entry that some
 * file still uses is held only by the ceiling in tooling/guards-checks.test.ts.
 */
export const ARCHIVE_ALLOWED = [
  { own: true, file: "ui\\/src\\/features\\/files\\/FileTree\\.tsx$", text: "\\bto (the )?Trash\\b", why: "the OS bin that \"Move to Trash\" in the file tree uses" },
  { own: true, file: "ui\\/src\\/features\\/project\\/DeleteProjectDialog\\.tsx$", text: "The folder itself goes to the Trash|Move the folder to the Trash too|Delete and trash folder|folder goes to this computer's trash", why: "the OS bin the project folder can be moved to" },
  { own: true, file: "ui\\/src\\/features\\/settings\\/ThemeSection\\.tsx$", text: "theme to the trash", why: "the OS bin a theme file is moved to" },
  { own: true, file: "platform\\/src\\/web\\/index\\.ts$", text: "A browser has no trash", why: "the OS bin a file is moved to, which a browser lacks" },
  { own: true, file: "platform\\/src\\/tauri\\/index\\.ts$", text: "^trash_path$", why: "the name of the shell command that moves a file to the OS bin" },
  { own: true, file: "platform/src/web/index.ts$", text: "^trash$", why: "the `fs.resolve` purpose \"trash\": the entry that goes to the OS bin" },
  { own: true, file: "agent-host/src/dev-services/project-files.ts$", text: "^trash$", why: "the `fs.resolve` purpose \"trash\": the entry that goes to the OS bin" },
  { file: ".", text: "\\bapp-trash\\b", why: "the folder on disk where a removed app is kept" },
  { file: ".", text: "^(trash\\.\\w+|subagents\\.trash|messages\\.subagentTrashed)$", why: "protocol method names" },
  { file: "agent-host\\/src\\/dev-services\\/store\\/", text: "\\b(?:[a-z]\\.)?trash\\b(?=[),]| =| TEXT| FROM| (?:as|AS)\\b)|\\btrashed_at\\b|\\b(?:as|AS) trashed?\\b|^trash$|\\bsubagent_messages_trash\\b", why: "SQL on the `sessions.trash` and `subagent_messages.trashed_at` columns" },
  { own: true, file: "protocol\\/src\\/commands\\/files\\.ts$", text: "^trash$", why: "the `fs.resolve` purpose \"trash\": the entry that goes to the OS bin" },
]
