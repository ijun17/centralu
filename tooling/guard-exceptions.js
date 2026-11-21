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
      counts: { 'mgr.trash.emptyTrash': 1, 'mgr.trash.purgeSession': 1 },
      reason: 'The RPC handler: only the person deletes for good, and only through the RPC (#204)',
    },
    'packages/agent-host/src/sessions/app-sessions.ts': {
      counts: { 'this.host.purgeSession': 1 },
      reason: 'The one deletion the host makes itself (#378): a finished app-agent session, once its record is kept in the session archive. It reaches the purge only through agentRunEnded after a clean run (app-agents.test.ts holds when it does and when the session stays)',
    },
    'packages/agent-host/src/sessions/manager.ts': {
      counts: { 'self.trash.purgeSession': 1 },
      reason: "The manager hands app-sessions the same purge from its session archive (session-trash.ts, #428); the same call, not another caller",
    },
    'packages/agent-host/src/sessions/session-trash.ts': {
      counts: { 'this.host.store.trash.purgeSession': 1, 'this.purgeSession': 1 },
      reason: 'emptyTrash purges one by one; purgeSession removes the rows through the store',
    },
  },
  'subagent-purge-callers': {
    'packages/agent-host/src/rpc.ts': {
      counts: { 'mgr.trash.purgeSubagentSteps': 1 },
      reason: 'The RPC handler: only the person deletes subagent steps for good, and only through the RPC (#204)',
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
    'packages/ui/src/features/assistant/AssistantView.tsx': {
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
    'packages/ui/src/features/sidebar/AssistantButton.tsx': {
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

/**
 * Files inside a swept folder that guard/comments does not read yet, because another change is editing them or their header cannot be
 * changed without a tool reading it as a comment it must keep (#2355); each sweep removes the lines it clears
 */
export const COMMENTS_LEFT = [
  'packages/agent-host/src/app-list-events.test.ts',
  'packages/agent-host/src/apps/external/app-process-sweep.test.ts',
  'packages/agent-host/src/apps/external/app-start-env.ts',
  'packages/agent-host/src/apps/external/app-template.test.ts',
  'packages/agent-host/src/apps/external/broker.ts',
  'packages/agent-host/src/apps/external/capabilities.ts',
  'packages/agent-host/src/apps/external/desk.ts',
  'packages/agent-host/src/apps/external/discovery.test.ts',
  'packages/agent-host/src/apps/external/limits.test.ts',
  'packages/agent-host/src/apps/external/manifest.ts',
  'packages/agent-host/src/apps/external/runtime.ts',
  'packages/agent-host/src/apps/external/test-helpers.ts',
  'packages/agent-host/src/data-dir.test.ts',
  'packages/agent-host/src/data-dir.ts',
  'packages/agent-host/src/lifecycle/host-process.test.ts',
  'packages/agent-host/src/links/links.test.ts',
  'packages/agent-host/src/links/own-turn-report.test.ts',
  'packages/agent-host/src/links/stored.test.ts',
  'packages/agent-host/src/links/stored.ts',
  'packages/agent-host/src/log-file.test.ts',
  'packages/agent-host/src/log-file.ts',
  'packages/agent-host/src/mail/delivery.ts',
  'packages/agent-host/src/mail/frame.ts',
  'packages/agent-host/src/mail/messages.ts',
  'packages/agent-host/src/main.ts',
  'packages/agent-host/src/os.ts',
  'packages/agent-host/src/os/kill-tree.test.ts',
  'packages/agent-host/src/os/real.test.ts',
  'packages/agent-host/src/sessions/app-agents.test.ts',
  'packages/agent-host/src/sessions/ask-project-flow.ts',
  'packages/agent-host/src/sessions/assistant-seat.ts',
  'packages/agent-host/src/sessions/auto-continue.test.ts',
  'packages/agent-host/src/sessions/child-ownership.ts',
  'packages/agent-host/src/sessions/child-reports-held.test.ts',
  'packages/agent-host/src/sessions/child-reports.ts',
  'packages/agent-host/src/sessions/delegation-waits.ts',
  'packages/agent-host/src/sessions/error-kind.ts',
  'packages/agent-host/src/sessions/interruption-watch.ts',
  'packages/agent-host/src/sessions/interruptions.test.ts',
  'packages/agent-host/src/sessions/interruptions.ts',
  'packages/agent-host/src/sessions/manager.ts',
  'packages/agent-host/src/sessions/remote-agents.test.ts',
  'packages/agent-host/src/sessions/session-app-wiring.ts',
  'packages/agent-host/src/sessions/session-events.ts',
  'packages/agent-host/src/sessions/session-start.ts',
  'packages/agent-host/src/sessions/tool-definitions.ts',
  'packages/agent-host/src/sessions/tool-seats.ts',
  'packages/agent-host/src/sessions/turn-answer.ts',
  'packages/agent-host/src/sessions/turn-continue.ts',
  'packages/agent-host/src/transport/limited-token.test.ts',
  'packages/agent-host/src/transport/link-proof.test.ts',
  'packages/agent-host/src/transport/server.test.ts',
  'packages/agent-host/src/update-apply.test.ts',
  'packages/agent-host/src/updates.test.ts',
]

/**
 * The source files `guard/comments` holds above its 35% share of comment lines (#2355), each at its share now. Most are
 * type declarations whose fields each keep one line the type cannot say (what absence means, what an older peer does, a
 * unit, a security consequence); the rest keep platform facts, races or measured numbers. The guard holds each number as a
 * ceiling, and tooling/guards-checks.test.ts fails until a change that brings a file down lowers its line (at or under
 * 35%, removes it).
 */
export const COMMENT_SHARE_HELD = {
  files: {
    'packages/agent-host/src/apps/contract.ts': 67,
    'packages/agent-host/src/apps/external/app-entry.ts': 44,
    'packages/agent-host/src/apps/external/app-process.ts': 37,
    'packages/agent-host/src/apps/external/change-reflector.ts': 39,
    'packages/agent-host/src/apps/external/error-log.ts': 42,
    'packages/agent-host/src/apps/external/errors.ts': 51,
    'packages/agent-host/src/apps/external/placement.ts': 38,
    'packages/agent-host/src/apps/external/runtime-types.ts': 64,
    'packages/agent-host/src/apps/external/scaffold.ts': 44,
    'packages/agent-host/src/apps/external/secrets.ts': 43,
    'packages/agent-host/src/apps/external/visibility.ts': 50,
    'packages/agent-host/src/idle.ts': 44,
    'packages/agent-host/src/keeper-link.ts': 41,
    'packages/agent-host/src/lifecycle/launch-env.ts': 46,
    'packages/agent-host/src/lifecycle/serve-credentials.ts': 37,
    'packages/agent-host/src/lifecycle/start.ts': 36,
    'packages/agent-host/src/links/link-deps.ts': 49,
    'packages/agent-host/src/links/machine-reach.ts': 51,
    'packages/agent-host/src/links/node-floor.ts': 40,
    'packages/agent-host/src/links/tunnel.ts': 39,
    'packages/agent-host/src/mail/address.ts': 36,
    'packages/agent-host/src/mail/asked-by.ts': 37,
    'packages/agent-host/src/mail/card-notices.ts': 47,
    'packages/agent-host/src/mail/last-response.ts': 43,
    'packages/agent-host/src/os/kill-tree.ts': 36,
    'packages/agent-host/src/os/port.ts': 37,
    'packages/agent-host/src/rpc-error.ts': 40,
    'packages/agent-host/src/sessions/agent-depth.ts': 38,
    'packages/agent-host/src/sessions/agent-start-gates.ts': 38,
    'packages/agent-host/src/sessions/app-agents.ts': 38,
    'packages/agent-host/src/sessions/app-messages.ts': 44,
    'packages/agent-host/src/sessions/ask-project.ts': 40,
    'packages/agent-host/src/sessions/assistant-home.ts': 36,
    'packages/agent-host/src/sessions/assistant-slot.ts': 38,
    'packages/agent-host/src/sessions/auto-compact.ts': 39,
    'packages/agent-host/src/sessions/cache-cost.ts': 43,
    'packages/agent-host/src/sessions/external-conversations.ts': 40,
    'packages/agent-host/src/sessions/handoff-notes.ts': 40,
    'packages/agent-host/src/sessions/host-cards.ts': 36,
    'packages/agent-host/src/sessions/host-tenure.ts': 38,
    'packages/agent-host/src/sessions/hub-preset.ts': 43,
    'packages/agent-host/src/sessions/launch-inputs.ts': 51,
    'packages/agent-host/src/sessions/linked-host.ts': 42,
    'packages/agent-host/src/sessions/merge-checks.ts': 52,
    'packages/agent-host/src/sessions/opened-settings.ts': 36,
    'packages/agent-host/src/sessions/own-agents.ts': 48,
    'packages/agent-host/src/sessions/project-registry.ts': 47,
    'packages/agent-host/src/sessions/remote-agent-words.ts': 53,
    'packages/agent-host/src/sessions/session-layout.ts': 37,
    'packages/agent-host/src/sessions/session-lines.ts': 38,
    'packages/agent-host/src/sessions/session-processes.ts': 46,
    'packages/agent-host/src/sessions/session-record.ts': 36,
    'packages/agent-host/src/sessions/session-settings.ts': 39,
    'packages/agent-host/src/sessions/session-tools.ts': 36,
    'packages/agent-host/src/sessions/snippet.ts': 40,
    'packages/agent-host/src/sessions/start-agent-terms.ts': 48,
    'packages/agent-host/src/sessions/start-agent.ts': 45,
    'packages/agent-host/src/sessions/tool-profiles.ts': 53,
    'packages/agent-host/src/sessions/tool-registry.ts': 41,
    'packages/agent-host/src/sessions/transcript-view.ts': 36,
    'packages/agent-host/src/sessions/turn-inputs.ts': 45,
    'packages/agent-host/src/sessions/ui-preferences.ts': 42,
    'packages/agent-host/src/sessions/updates-asked.ts': 36,
    'packages/agent-host/src/update-switches.ts': 41,
    'packages/core/src/grid/layout.ts': 44,
    'packages/platform/src/ports/apps.ts': 38,
    'packages/platform/src/ports/fs.ts': 49,
    'packages/platform/src/ports/lifecycle.ts': 56,
    'packages/platform/src/ports/preferences.ts': 43,
    'packages/platform/src/ports/projects.ts': 56,
    'packages/platform/src/ports/system.ts': 63,
    'packages/protocol/src/app-id.ts': 40,
    'packages/protocol/src/call-budget.ts': 40,
    'packages/protocol/src/commands/methods/apps.params.ts': 48,
    'packages/protocol/src/commands/methods/assistant.params.ts': 42,
    'packages/protocol/src/commands/methods/host.params.ts': 55,
    'packages/protocol/src/commands/methods/projects.params.ts': 47,
    'packages/protocol/src/commands/methods/sessions.params.ts': 45,
    'packages/protocol/src/commands/methods/settings.params.ts': 54,
    'packages/protocol/src/entities/apps.ts': 36,
    'packages/protocol/src/entities/sessions.ts': 38,
    'packages/protocol/src/entities/tools.ts': 41,
    'packages/protocol/src/entities/usage.ts': 37,
    'packages/protocol/src/turn-who.ts': 48,
    'packages/ui/src/features/files/dragPath.ts': 42,
    'packages/ui/src/features/session/RunMenu.tsx': 43,
    'packages/ui/src/features/session/autocompleteState.ts': 38,
    'packages/ui/src/features/session/dragLink.ts': 49,
    'packages/ui/src/features/session/guiCommands.ts': 41,
    'packages/ui/src/features/sidebar/layout.ts': 53,
    'packages/ui/src/store/state/appViews.ts': 49,
    'packages/ui/src/store/state/apps.ts': 50,
    'packages/ui/src/store/state/assistant.ts': 41,
    'packages/ui/src/store/state/conversation.ts': 55,
    'packages/ui/src/store/state/layers.ts': 45,
    'packages/ui/src/store/state/layout.ts': 54,
    'packages/ui/src/store/state/mail.ts': 60,
    'packages/ui/src/store/state/notifications.ts': 43,
    'packages/ui/src/store/state/preferences.ts': 50,
    'packages/ui/src/store/state/projects.ts': 54,
    'packages/ui/src/store/state/sessions.ts': 47,
  },
}
