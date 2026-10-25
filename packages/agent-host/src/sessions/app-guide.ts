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
 * (58d2335), and it knew nothing at all about the control-rail app's tools (#81, since removed). Which seat can
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
 * (profileAllows, toolDefsFor). Why this file does not import the registry: the registry
 * imports this file's topic list to draw the app_guide schema — wiring the import the other way
 * too would create a cycle.
 */
export type GuideSeats = { orchestrator: GuideTool[]; scoped: GuideTool[]; reader: GuideTool[] }

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
- Projects: **Add project** at the bottom of the sidebar adds a folder that exists (it opens a
  folder picker); **New folder** beside it makes a new, empty folder in ~/Centralu (or another
  location) and adds it, or clones a git repository (https or ssh) into it with that machine's own
  git and saved sign-ins. A linked machine's + offers both, made on that machine. The orchestrator
  makes a new project with create_project, and adds a folder that exists (here or on a linked
  machine) with its add_project command: either way the person approves the folder's full path on a
  card first. With zero projects there is no place to open New session from, so for "make me a
  project" use create_project, and for "add my folder" use add_project or point to Add project.
- Sleeping and waking: turning the app off and on again keeps the record and only drops the
  process — choosing the session, clicking the input box, or sending it a message wakes it back up.
- Worktree option (git repositories only): turning on "Run in a git worktree" in the New session
  window runs the session in a separate directory and branch, avoiding file conflicts.
- Handoff: session's ⋯ → Hand off to a fresh session… — the app builds a note from the stored
  conversation (or, if you choose, the current session writes it), and the new session starts from
  that note. You can choose the receiving tool. The dialog archives the original session after the
  handoff by default (it can be restored from Settings → Archive); a checkbox keeps it instead. The orchestrator can hand a session off too
  (its handoff_session command), after you approve its card unless the session is at rest and runs under a preset the orchestrator has itself; the original stays. A worktree session cannot be
  handed off yet.
- Archiving: session's ⋯ → Archive session…. The session leaves the sidebar and goes to the session
  archive (Settings → Archive), where the person can read it, restore it, or delete it for good.
  Nothing is deleted on its own. The dialog also asks whether deleting it for good should delete the
  conversation file on the tool's side (on by default); turning that off leaves the conversation on
  the tool, so it can be loaded again from the past-conversation list in the New session window.
- There is no menu to change a session's agent (claude ↔ codex). A new tool does not know the old
  conversation, so use a handoff to continue with a different tool. The orchestrator is the one
  exception (Settings → Orchestrator).`,

  apps: `# Apps
An app is a small tool built where it is used: a folder with a manifest (centralu.app.json) and an
MCP server. A person uses it through its screen, and agents call the same tools.
- Where they live: a project's apps are committed with that project and run only if the project is
  trusted; your own apps (the user folder) work in every project.
- Making one: a project row's ⋯ menu → New app…, or the + on "Your apps" in the sidebar. A builder
  session starts and writes the app with you.
- Using one: apps stand in the sidebar under their project (your own under "Your apps"); opening one
  shows its screen in the main area, and it can be pinned into the grid. When an agent calls an
  app tool that has a screen, the screen opens under that call's card in the conversation.
- Which sessions get which apps: the orchestrator gets your own apps, a project's sessions get
  that project's apps.
- Settings → Apps lists every app with its status and, when something is wrong, why.`,

  approvals: `# Approvals and permissions
Every session has a permission preset: Safe (ask for everything), Normal (ask when risky), Auto
(never ask).
- Normal follows the tool's own settings. Auto runs Codex with no sandbox and no permission prompts,
  like Claude's bypass permissions.
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
and approved skills; every session can always look at other sessions), Agents (how many agents run per project, how deep they may start agents, which model each difficulty runs), Apps (the app list), Notifications, Appearance, Permissions (saved approval rules),
Shortcuts (the shortcut list), Archive (archived sessions: read, restore, or delete for good), and Updates.`,

  updates: `# Updates
Check from Settings → Updates. It reports a new version based on the npm registry, and the person
clicks to install it. With "Automatic updates" on (the default), the check runs on startup, every six hours, when
Updates opens, and on focus when the last check is over an hour old. With it off, use Check now.
Ordinary checks follow npm, including dist-tag rollbacks. Installing reuses a successful check
from the last minute or checks again. Only while installing can a higher stored version seen less
than an hour ago win over the fresh tag. Older observations yield to npm. If the check fails, it
uses the stored version and says so. Checks preserve install errors until the next install attempt.
An install asked for with nothing newer known checks first; nothing newer is then "Up to date", not
a failure. The installed app is replaced by the npm release, even a higher released version, except
a newer local build (<base>.local.N) waiting to be applied, which is kept; the line says so.
Once installed, the desktop app offers "Apply now": it relaunches into the new version, and running
agents, terminals and commands keep going. "Automatic updates" also
installs a new version without a click and applies it once no session is working or waiting, no
terminal or command is running, and the person is not typing. An agent can ask for the same Apply now
(update_centralu's apply action): under auto it applies, under normal the person is asked on a card (none while this switch is on and nothing else is running),
under safe it is refused, and it never applies what the button would not offer. With it on, a failed install is tried
again after 10 minutes, then 1 hour, then every 6 hours; the error stays until the next attempt.
From the terminal: \`centralu update\`. \`centralu install --force\` replaces a kept local build.`,
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
There are two seats that direct sessions, and every other session directs the agents it starts.
- The orchestrator (this may be you): there is only one per app, and it watches and directs every
  session across projects.
- A coordinating session: it only watches and directs its assigned member sessions, and it cannot
  create or delete sessions. Nothing in the app creates a new one right now; one created earlier
  keeps working. It has no row in the sidebar; the person finds it by name in search or the command
  palette, and in the inbox when it waits on them.
None of them can approve on another session's behalf — the target session's approval settings stay
exactly as they are.

The list below is generated directly from the app's tool registry.

## Tools the orchestrator calls
${toolLines(seats.orchestrator)}

## Tools a coordinating session calls
${toolLines(seats.scoped)}

## Tools every other session calls
It reads other sessions: from a trusted project any project's, here and on linked machines (not the
orchestrator's or an app's); from an untrusted one its own project's. It acts
only in its own project: with the person's consent it starts other agents there (in its folder or a
new worktree) and works with the ones it started; ask_project reaches another project. Settings →
Orchestrator can turn them off.
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
  const t = topic.trim().toLowerCase()
  const section = (k: AppGuideTopic) => (k === 'orchestrator' ? orchestratorTopic(seats) : STATIC[k])
  if ((APP_GUIDE_TOPICS as readonly string[]).includes(t)) return { text: section(t as AppGuideTopic) }
  /*
   * The schema offers the topics as an enum (#523), but a caller that does not check it (Codex calls MCP tools from
   * code in its `exec` tool) can still send its own words. One that names a topic, even in the singular ("session
   * settings", "approval"), gets that topic and the list rather than a failed first call. The last such word wins,
   * as the head of an English phrase comes last ("session settings" is about settings).
   */
  const words = t.split(/[^a-z]+/).filter(Boolean).reverse()
  const near = words.map((w) => APP_GUIDE_TOPICS.find((k) => w === k || w === k.replace(/s$/, ''))).find((k) => k !== undefined)
  if (near) return { text: `(Read as "${near}". Topics: ${APP_GUIDE_TOPICS.join(', ')})\n\n${section(near)}` }
  return { text: `No such topic: ${topic}. Available topics: ${APP_GUIDE_TOPICS.join(', ')}`, isError: true }
}
