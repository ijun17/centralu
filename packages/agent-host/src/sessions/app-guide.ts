/**
 * The app guide given to the orchestrator (#30).
 *
 * **It is code, not a file — that is the whole point of this file.** If docs/ were read at
 * runtime, every session with write access to that folder could edit the orchestrator's
 * knowledge — one step removed from the attack that succeeded before by planting an AGENTS.md
 * (a hole confirmed by measurement, which is why orchestrator-home.ts turned off reading folder
 * documents). The content here is compiled into the build, so changing it must go through a pull
 * request in this repository.
 *
 * That is also why it is not auto-extracted from docs/. Extracting it would pull in the whole
 * 44KB specification and bury the orchestrator's context — this guide's job is "explain the app
 * to the person," and for that job a summary a person chose is better than the raw source. When
 * docs change, a person updates this file too.
 *
 * **The one exception: the tool list is not written by hand** (M4 P-4). The hand-written list was
 * wrong twice: it kept advertising `archive_session` even after the archive feature was removed
 * (58d2335), and it knew nothing at all about the control-rail app's tools (#81). Which seat can
 * call which tool is already decided by the tool registry (orchestrator-tools.ts), so that
 * decision is taken as-is and rendered here (`GuideSeats`). The registry is also compiled code,
 * so the reason above (nothing is read from a file at runtime) still holds. Tool names left in
 * the hand-written text are checked against the registry by app-guide.test.ts.
 */

export const APP_GUIDE_TOPICS = ['overview', 'sessions', 'orchestrator', 'apps', 'approvals', 'settings', 'updates'] as const
export type AppGuideTopic = (typeof APP_GUIDE_TOPICS)[number]

/** One tool entry from the registry — the name and description (the same description given to the model) */
export type GuideTool = { name: string; description: string }

/**
 * The tools each of the three directing seats can call **right now**, and the light, read-only set
 * every other session gets (#320).
 *
 * The caller (orchestrator-tools.ts) fills this in from the registry's decisions
 * (profileAllows, appToolEntries). Why this file does not import the registry: the registry
 * imports this file's topic list to draw the app_guide schema — wiring the import the other way
 * too would create a cycle.
 */
export type GuideSeats = { orchestrator: GuideTool[]; manager: GuideTool[]; scoped: GuideTool[]; reader: GuideTool[] }

const STATIC: Record<Exclude<AppGuideTopic, 'orchestrator'>, string> = {
  overview: `# Centralu overview
A desktop app that runs, watches, and steers several Claude Code and Codex CLI sessions in one window.
(⌘ in shortcuts is for macOS. On other operating systems it is Ctrl.)
- Left sidebar: the Orchestrator and Grid buttons at the top, the project and session list below
  them, and Add project at the bottom. A project is one local directory.
- Center: the conversation of the chosen session. Pressing the sidebar's Grid button shows several
  sessions side by side (dragging a session onto that button also puts it in the grid).
- Right evidence panel: it stands only while viewing a single session. It has Git, History (commit
  graph), Files, and Terminal tabs; ⌘⇧1 through ⌘⇧4 pick a tab and ⌘B collapses it.
- Waiting (⌘I): gathers sessions waiting on the person — waiting for approval, an error, or waiting
  for a reply (the turn ended and it awaits the next message). ⌘⇧A goes to the next waiting session.
- The command palette is ⌘K. Settings opens from the Settings button in the top bar or Open
  settings in the palette.
Install and update through npm (\`npm i -g centralu\`; you can also check and install from inside the app).
For a question this guide does not cover (including bug reports and feature requests), do not
answer from a guess; point to a GitHub issue: https://github.com/ijun17/centralu/issues`,

  sessions: `# Sessions
One session = one agent process (Claude Code or Codex).
- Creating one: hover over a project row in the sidebar for the ⋯ menu → New session. In the
  window that opens, start a new conversation, or pick and load a past conversation that tool had
  in that folder (Load).
- Projects are created from **the Add project button at the bottom of the sidebar** (pressing it
  opens a folder picker). The folder-picker link shown when the orchestrator's conversation is
  empty opens the same window. With zero projects there is no place to open New session from, so
  for "how do I make a project?" point to Add project and use propose_project to mark the spot.
- Sleeping and waking: turning the app off and on again keeps the record and only drops the
  process — choosing the session, clicking the input box, or sending it a message wakes it back up.
- Worktree option (git repositories only): turning on "Run in a git worktree" in the New session
  window runs the session in a separate directory and branch, avoiding file conflicts.
- Handoff: session's ⋯ → Hand off to a fresh session… — the current session writes a note, and the
  new session starts from that note. You can choose the receiving tool. A worktree session cannot
  be handed off yet.
- Deleting: session's ⋯ → Delete session…. By default this also deletes the conversation file on
  the tool's side. Turning that option off leaves the conversation on the tool, so it can be loaded
  again from the past-conversation list in the New session window.
- There is no archive feature — it was removed. Deleting is the only way to clear something from
  the list.
- There is no menu to change a session's agent (claude ↔ codex). A new tool does not know the old
  conversation, so use a handoff to continue with a different tool. The orchestrator is the one
  exception (Settings → Orchestrator).`,

  apps: `# Apps
Experimental features arrive as apps. Turn each one on or off in Settings → Apps — turning one off
retires its screen and tools while keeping its data. The only app right now is the Control rail,
and it is on by default.

## Control rail
The right-hand rail on the orchestrator screen (drag the left edge to resize it). It has four panes.
- Notices: alerts that call out the person by name. An agent raises one with control_notify, and
  one also appears when a watch (below) fires or a task finishes. The person clears it with ×; an
  agent can only raise one, not clear it.
- My turn: sessions waiting on the person. Approving, rejecting, and a one-line reply (Reply…) can
  all be finished right in the rail.
- Tasks: work items. + New task sets a name, a goal, and member sessions, and a lead (coordinating
  session) that watches only that task stands up. The lead splits work among its members, writes
  status on the task board, and calls the person to the rail when needed. The orchestrator can also
  create a task with control_create_task. Finished tasks move down under Done.
- Running: the sessions working right now, and the last thing each one said.
Settings → Apps → Control rail panel: how many times the rail has been used, the tool, model, and
reasoning effort used to spin up a lead (Claude and high by default), and Watches. A watch is a
literal match against one line of a tool call, and firing it raises an urgent notice in the rail.
It does not stop the agent.
When the Control app is off, lead sessions still show in the sidebar's No app list — turning off
the app does not cut off access to the session.`,

  approvals: `# Approvals and permissions
Every session has a permission preset: Safe (ask for everything), Normal (ask when risky), Auto
(never ask).
- Normal follows the tool's own settings. Auto skips the permission check in Claude, and in Codex
  it does not ask but runs inside the working folder's sandbox.
- When an agent wants to do something risky, an approval card appears — y (allow) / n (deny) /
  a (always allow in this session), ⌥a (always allow in this project).
- "Always allow" is saved as a rule and can be cleared from Settings → Permissions.
- Only the person changes this preset — the orchestrator's settings tool (update_session_settings)
  has no such field. (If it did, switching the preset to Auto would open a back door around
  approval.)`,

  settings: `# Session settings (the menu below the input box)
- Model: pick from the official list the tool reports.
- Effort: reasoning effort (shown only when the model supports it).
- Verbosity: response length (Codex only) — shorter comes back faster.
- Speed: response speed (shown only when the model reports speed tiers) — faster uses more usage.
- Permissions: the approval preset (see approvals above).
Changing a live session's settings restarts the conversation in place — the change applies from
the next turn on.
App settings (the Settings button in the top bar): Orchestrator (change the orchestrator's tools
and approved skills, and whether every session can look at its own project), Apps, Notifications, Appearance, Permissions (saved approval rules),
Shortcuts (the shortcut list), and Updates.`,

  updates: `# Updates
Check from Settings → Updates. It reports a new version based on the npm registry, and the person
clicks to install it. The check for a new version runs on startup and every six hours, and it can
be turned off.
Once installed, the desktop app offers "Apply now": it relaunches into the new version, and running
agents, terminals and commands keep going. "Apply updates automatically when idle" (off by default)
installs a new version without a click and applies it once no session is working or waiting, no
terminal or command is running, and the person is not typing.
From the terminal: \`centralu update\`.`,
}

/**
 * The first clause of a tool's description — that much is enough for one guide line.
 *
 * The full description is a usage note for the model, so it is long (when to use it, when not
 * to). Telling a person "what can this seat do" only needs the first sentence. Issue numbers and
 * emphasis markers (warnings meant for the model) carry no meaning in this one line, so they are
 * stripped.
 */
function gist(description: string): string {
  const first = description.split(/ — |\. /)[0] ?? description
  return first
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/[.:]\s*$/, '')
    .trim()
}

function toolLines(tools: readonly GuideTool[]): string {
  return tools.length === 0 ? '- (none)' : tools.map((t) => `- ${t.name}: ${gist(t.description)}`).join('\n')
}

function orchestratorTopic(seats: GuideSeats): string {
  return `# The orchestrator and directing seats
There are three seats that direct sessions.
- The orchestrator (this may be you): there is only one per app, and it watches and directs every
  session across projects.
- The worktree manager: one per project. It appears automatically the first time a worktree session
  is created, or it can be started ahead of time from the project's ⋯ menu → Start worktree manager.
  It only watches and directs its own worktree children.
- The lead (a coordinating session): created by a task in the Control app (see the apps topic). It
  only watches and directs its assigned member sessions, and it cannot create or delete sessions.
None of them can approve on another session's behalf — the target session's approval settings stay
exactly as they are.

The list below is generated directly from the app's tool registry. A turned-off app's tools are
left out.

## Tools the orchestrator calls
${toolLines(seats.orchestrator)}

## Tools the worktree manager calls
${toolLines(seats.manager)}

## Tools the lead calls
${toolLines(seats.scoped)}

## Tools every other session calls
Read-only, and only that session's own project. Settings → Orchestrator can turn them off.
${toolLines(seats.reader)}`
}

/**
 * Given a topic, returns that section; given none, returns the overview and the topic list.
 * An unknown topic is rejected along with the list — better than a quiet, empty answer.
 */
export function appGuide(topic: string | undefined, seats: GuideSeats): { text: string; isError?: boolean } {
  if (!topic) {
    return {
      text: STATIC.overview + '\n\nOther topics: ' + APP_GUIDE_TOPICS.filter((t) => t !== 'overview').join(', '),
    }
  }
  const t = topic.toLowerCase()
  if (t === 'orchestrator') return { text: orchestratorTopic(seats) }
  if ((APP_GUIDE_TOPICS as readonly string[]).includes(t)) {
    return { text: STATIC[t as Exclude<AppGuideTopic, 'orchestrator'>] }
  }
  return { text: `No such topic: ${topic}. Available topics: ${APP_GUIDE_TOPICS.join(', ')}`, isError: true }
}
