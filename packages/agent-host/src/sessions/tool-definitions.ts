import { z } from 'zod'
import { AgentDifficulty, ToolName } from '@cc/protocol'
import type { IfBusy } from '../adapters/contract.js'
import type { ToolProfile } from '../apps/contract.js'
import { APP_GUIDE_TOPICS } from './app-guide.js'

/** What a busy session can be asked to do instead (#677): the contract's IfBusy, as the one schema every tool takes */
const IF_BUSY = z.enum(['note', 'queue', 'fork', 'fork_read'] as const satisfies readonly IfBusy[])
// …and every one of them: a value the contract adds and this schema lacks would be refused before the manager saw it
const _ifBusyComplete: IfBusy extends z.infer<typeof IF_BUSY> ? true : never = true

/** update_centralu's actions: one enum for the orchestrator's definition and the reader's */
const UPDATE_ACTION = z.enum(['check', 'install', 'apply'])

/**
 * The **single definition** of the orchestrator tools.
 *
 * The path for attaching tools differs by adapter:
 *   Claude — an in-process MCP (no separate process)
 *   Codex  — comes back to the host through a stdio bridge (HTTP did not work out, measured)
 *
 * Even with two paths, **there must be one tool.** If each path defines its own, the name or
 * description drifts apart and the same app ends up with tools that behave differently. It is
 * decided once here and both sides pull it from here.
 */

export const ORCHESTRATOR_TOOLS = [
  {
    name: 'update_centralu',
    description:
      'Checks for or installs a Centralu update, or applies the installed one (the window relaunches; agents keep running). Never changes the person\'s automatic-update setting.',
    schema: z.object({ action: UPDATE_ACTION }),
  },
  {
    name: 'list_sessions',
    description:
      'The list of sessions this app manages (project, state, last line). The calling session itself is left out, and a seat with a narrow view (a lead) sees only the sessions within its own view.',
    schema: z.object({}),
  },
  {
    name: 'recall',
    description:
      'Searches across the entire past conversation (crossing projects). Use it to recall something like "the way that was done over there last time." ' +
      'It finds what people and agents said and the agents\' reasoning, not tool calls or their output (#221): ' +
      'to see the commands a session ran, use read_session with tools.',
    schema: z.object({
      query: z.string().describe('The word to search for. A word catches better than a sentence.'),
      limit: z.number().optional().describe('How many snippets to fetch (12 by default).'),
    }),
  },
  {
    name: 'read_session',
    description:
      "Reads a session's recent conversation. Use it to check on something already finished — for waiting on the result of work you just assigned, send_to_session's reportBack is the right tool.",
    schema: z.object({
      sessionId: z.string().describe('The session id from list_sessions.'),
      limit: z.number().optional().describe('How many lines to read (40 by default, most recent first).'),
      around: z
        .number()
        .optional()
        .describe('The seq recall gave. If given, reads around that spot (otherwise the very end).'),
      tools: z
        .boolean()
        .optional()
        .describe('Whether to expand tool-call bodies too. Collapsed to one line by default — a full script would bury the conversation.'),
    }),
  },
  {
    name: 'send_to_session',
    description: 'Sends a message to a session to assign work. sessionId must be one that list_sessions gave.',
    schema: z.object({
      sessionId: z.string().describe('The session id from list_sessions.'),
      text: z.string().describe('The instruction to send to that session.'),
      reportBack: z
        .boolean()
        .optional()
        .describe('Whether to notify me when that session finishes the work. Set true if the person is waiting for the result.'),
      // #677: a session busy with a turn that is not yours returns the choices, which name this argument; no words here
      ifBusy: IF_BUSY.optional(),
    }),
  },
  {
    /*
     * #676: a card raised in the turn this seat gave a session (send_to_session to a session at rest) comes to this
     * seat too; read_session shows it, and this answers it. The directing seats' form of agent_session's "answer",
     * which an ordinary session has. Rare for the orchestrator (RARE_COMMANDS): the notice of a card names the call.
     */
    name: 'answer_question',
    description: 'Answers a card a session raised in the turn you gave it (read_session shows it). One line per question; allow/deny for an approval.',
    schema: z.object({ sessionId: z.string(), card: z.string().optional(), text: z.string() }),
  },
  {
    name: 'app_guide',
    description:
      'The guide to this app (Centralu) (#30). When the person asks something like "what can I do with this app?," read it from here and answer — do not answer from a guess.',
    schema: z.object({
      // An enum, not a string the description lists (#523): asked in its own words, the model missed every first call
      topic: z.enum(APP_GUIDE_TOPICS).optional().describe('If omitted, returns the overview and the topic list.'),
    }),
  },
  {
    name: 'update_session_settings',
    description:
      "Changes a session's model, reasoning effort, or response length (#30). Permission (approval) settings are not here — only the person changes those. A working session is refused (applying the change needs a restart, which would kill the turn in progress).",
    schema: z.object({
      sessionId: z.string().describe('The session id from list_sessions.'),
      model: z.string().nullable().optional().describe("Model id. If null, the tool's default."),
      effort: z.string().nullable().optional().describe('Reasoning effort. If null, the default.'),
      verbosity: z.string().nullable().optional().describe('Response length (Codex only). If null, the default.'),
    }),
  },
  {
    /*
     * Replaced propose_project (#515), which only lit up the sidebar's Add project button: asked for a project, the
     * orchestrator now makes it, behind a card the person approves. One tool for one intent, so the model is not
     * choosing between pointing and doing, and the set does not grow. A folder that already exists is add_project's
     * (#1220), a rare command. Kept short: it rides in every orchestrator request (RESIDENT_BUDGET_CHARS).
     */
    name: 'create_project',
    description:
      "Makes a new project: an empty folder, or a clone of git, in ~/Centralu or in parent. The person approves it on a card first; " +
      'the call waits for the answer. Never reuses an existing folder: the add_project command adds one.',
    schema: z.object({
      name: z.string().optional().describe("Folder and project name; with git, the repository's if omitted."),
      parent: z.string().optional().describe('Full path of the folder to make it in.'),
      git: z.string().optional().describe('Repository to clone: https, ssh or user@host:path.'),
      branch: z.string().optional(),
      // A linked machine (#82 phase 4), by the name list_sessions shows after "on"
      machine: z.string().optional().describe('A linked machine to make it on; this computer if omitted.'),
    }),
  },
  {
    /*
     * #1220: the person linked a laptop and asked for two folders on it as projects, which create_project could not do.
     * A rare command (RARE_COMMANDS), not a resident tool (#1205). The card shows what the folder's machine found there.
     */
    name: 'add_project',
    description:
      'Adds a folder that already exists, on this computer or a linked machine, as a project. The person approves it on a card ' +
      'showing the machine, the full path and whether it is a git repository; the call waits for the answer. A missing path, a file ' +
      'or a folder that is already a project is refused first.',
    schema: z.object({
      path: z.string().describe("The folder's full path on that machine; ~ is that machine's home."),
      machine: z.string().optional().describe('A linked machine, by the name list_machines gives; this computer if omitted.'),
    }),
  },
  {
    // #1220: what to pass as `machine`. Reading only, no card
    name: 'list_machines',
    description: 'Lists the linked machines: name, status, OS and shell, and whether each reconnects by itself (Auto reconnect).',
    schema: z.object({}),
  },
  /*
   * #1219: the linked machines, as the Machines screen manages them. Rare commands (RARE_COMMANDS). A change to a
   * machine or to this computer's reach waits for the person's card; reconnecting and Auto reconnect do not, except
   * that starting Centralu where it is stopped does (#1143), and so does undoing what the person chose (#1341):
   * reconnecting a machine they disconnected or turned Auto reconnect off for, and turning Auto reconnect back on.
   */
  {
    name: 'add_machine',
    description:
      'Links another computer this one reaches over ssh. It is probed first (one ssh, nothing changed there); the person approves a card ' +
      'naming the target, what runs there and what linking does. Nothing is installed.',
    schema: z.object({
      sshTarget: z.string().describe("A host alias from this computer's ~/.ssh/config, or user@host."),
      name: z.string().optional().describe('What to call it; the host name if omitted.'),
      wslDistro: z.string().optional().describe('On a Windows machine, a WSL distro to link instead of Windows itself.'),
    }),
  },
  {
    name: 'install_machine',
    description:
      "Installs this computer's Centralu version on a linked machine, or updates it (stopping and restarting the Centralu there). The person approves a card first.",
    schema: z.object({
      machine: z.string().describe('The machine, by the name list_machines gives.'),
      action: z.enum(['install', 'update']).optional().describe('install (the default) or update.'),
    }),
  },
  {
    name: 'remove_machine',
    description: "Unlinks a machine after the person's card: its sessions and projects leave this computer's lists. Nothing on the machine changes.",
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'reconnect_machine',
    description:
      'Tries the link to a machine again now. No card for a machine that is away on its own with Auto reconnect on. The person approves a card to start Centralu on a machine where it is stopped, and to connect a machine they disconnected or turned Auto reconnect off for.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'set_machine_auto_reconnect',
    description:
      "Turns a machine's Auto reconnect on or off. On: this computer connects when it starts and again after every drop. Off: it tries once at start, then only when the person presses Connect; nothing here connects it for you. Turning it off needs no card; turning it back on does, since the person turned it off.",
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.'), on: z.boolean() }),
  },
  {
    name: 'set_machine_autostart',
    description: 'Turns on or off a machine starting Centralu when it boots. The person approves a card first.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.'), on: z.boolean() }),
  },
  /*
   * #1219, the machine calls left: disconnect acts at once; rolling back, uninstalling and accepting differing versions
   * wait for the person's card; the last two only read.
   */
  {
    name: 'disconnect_machine',
    description: 'Closes the link to a machine and tries none until the person connects it again. Acts at once; the machine and its sessions stay listed.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'rollback_machine',
    description: 'Puts the machine back on the Centralu version installed there before the last update, one step. The person approves a card first.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'uninstall_machine',
    description: 'Stops Centralu on a machine and removes what this computer installed there; its data stays and it stays linked. The person approves a card first.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'machine_activity',
    description: 'Says what an update or a restart would stop on a machine: sessions working, approvals waiting, background work, terminals. Reads only.',
    schema: z.object({ machine: z.string().describe('The machine, by the name list_machines gives.') }),
  },
  {
    name: 'list_ssh_hosts',
    description: "Lists the hosts of this computer's ssh config, with the machines already linked through each; add_machine takes an alias. Reads only.",
    schema: z.object({}),
  },
  /*
   * #1219: the preferences. Rare commands (RARE_COMMANDS), through the window's own calls. Only the
   * reversible settings the window offers have a field; trust, approval rules and what widens agents' reach have none.
   */
  {
    name: 'get_preferences',
    description: "Reads the person's settings: theme and the themes to choose from, text size, fonts, line height, the notification switches, idle sleep, automatic updates.",
    schema: z.object({}),
  },
  {
    name: 'set_preferences',
    description:
      'Changes settings the window offers, as it does; give only what changes (get_preferences shows the values and the choices). ' +
      'Turning on autoUpdate, or turning off the approval notification (or the sound while it notifies), asks the person first; the rest act at once.',
    schema: z
      .object({
        theme: z.string().optional().describe('A theme by id or name. It sets the dark or light side by its base and shows that side.'),
        textSize: z.number().optional().describe('0.85, 0.925, 1, 1.1 or 1.25; another number lands on the nearest.'),
        bodyFont: z.string().optional().describe('A font family; empty for the default.'),
        codeFont: z.string().optional().describe('A font family; empty for the default.'),
        lineHeight: z.enum(['compact', 'normal', 'relaxed']).optional(),
        idleSleepMinutes: z.union([z.number().int().positive(), z.literal('never')]).optional().describe('Minutes before an idle session sleeps, or "never".'),
        autoUpdate: z.boolean().optional().describe('Automatic updates: check for, install, and apply a newer Centralu when idle.'),
        moveIdleSessionsToNewAgentCli: z.boolean().optional(),
        notifications: z
          .object({
            approval: z.boolean().optional().describe('Notify when an agent is blocked on an approval.'),
            done: z.boolean().optional().describe('Notify when a session finishes out of sight.'),
            whenFocused: z.boolean().optional().describe('Notify even while the app is focused.'),
            sound: z.boolean().optional(),
          })
          .strict()
          .optional()
          .describe('The notification switches to change; the rest stay.'),
      })
      .strict(),
  },
  /*
   * #1219: the trash. Rare commands. Listing, restoring and moving subagent steps there act at once; deleting for good
   * waits for the person's card naming what goes.
   */
  {
    name: 'list_trash',
    description: 'Lists the trash: deleted sessions, kept app runs, trashed subagent steps, and sessions whose subagent steps could be trashed.',
    schema: z.object({}),
  },
  {
    name: 'restore_trashed',
    description: 'Brings a session back from the trash, or (what "steps") puts its trashed subagent steps back under their cards. No card.',
    schema: z.object({ sessionId: z.string().describe('The id list_trash gives.'), what: z.enum(['session', 'steps']).optional() }),
  },
  {
    name: 'trash_subagent_steps',
    description: "Moves a live session's subagent steps to the trash (its conversation stays); restore_trashed brings them back. No card.",
    schema: z.object({ sessionId: z.string().describe('The id list_trash gives.') }),
  },
  {
    name: 'delete_trashed',
    description: 'Deletes one trashed session, or (what "steps") its trashed subagent steps, for good. The person approves a card naming what goes first.',
    schema: z.object({ sessionId: z.string().describe('The id list_trash gives.'), what: z.enum(['session', 'steps']).optional() }),
  },
  {
    name: 'empty_trash',
    description: 'Deletes everything listed in the trash for good, kept app runs included. The person approves a card naming what goes first.',
    schema: z.object({}),
  },
  /*
   * #1219, third slice: trust. Rare commands. Listing acts at once; trusting and taking trust away wait for the
   * person's card (untrusting drops the project's own deny rules and hooks).
   */
  {
    name: 'list_projects',
    description: 'Lists the projects with their id, folder, machine and whether each is trusted.',
    schema: z.object({}),
  },
  {
    name: 'set_project_trust',
    description: "Trusts a project (its apps run, its settings apply) or takes trust away. Either waits for the person's card.",
    schema: z.object({ project: z.string().describe('Its name or id, from list_projects.'), trusted: z.boolean() }).strict(),
  },
  {
    name: 'list_approval_rules',
    description: 'Lists the approval rules: the standing "always allow" answers the person gave on cards, with what each allows and where.',
    schema: z.object({ project: z.string().optional().describe('Only this project\'s rules: its name or id.') }).strict(),
  },
  {
    name: 'remove_approval_rule',
    description: 'Removes an approval rule, so that action asks again. Acts at once. No command adds a rule: only the person\'s "always" on a card does.',
    schema: z.object({ id: z.number().int().describe('The id list_approval_rules gives.') }).strict(),
  },
  {
    name: 'list_app_grants',
    description: "Lists apps with their trust, sharing and the person's remembered answers to what each asked for, and the consents of one project reaching another.",
    schema: z.object({ app: z.string().optional().describe('Only this app: its id or name.'), project: z.string().optional().describe('Only this project\'s apps, or where app is.') }).strict(),
  },
  {
    name: 'forget_app_answer',
    description: "Forgets an app grant: the person's remembered answer to one thing an app asked for, so it asks again. Acts at once.",
    schema: z.object({ app: z.string().describe('Its id or name.'), project: z.string().optional(), capability: z.string().describe('As list_app_grants names it.') }).strict(),
  },
  {
    name: 'revoke_project_consent',
    description: 'Revokes a grant of one project reaching another (a remembered consent), so the next reach asks again. Acts at once.',
    schema: z.object({ from: z.string().describe('Project name or id.'), to: z.string().describe('Project name or id.'), kind: z.enum(['delegate', 'apps', 'agents']) }).strict(),
  },
  {
    name: 'share_app',
    description: "Grants a project's inner app to the other projects (shares it), or stops. Sharing waits for the person's card; stopping acts at once.",
    schema: z.object({ app: z.string().describe('Its id or name.'), project: z.string().optional(), shared: z.boolean() }).strict(),
  },
  {
    name: 'set_agent_limits',
    description: "Changes the limits on agents: running agents per project, levels of sessions that may start agents. Waits for the person's card.",
    schema: z
      .object({
        agentCeiling: z.union([z.number().int().min(0), z.literal('preset')]).optional().describe('0 is unlimited; "preset" uses the preset\'s own.'),
        agentDepth: z.number().int().optional().describe('1 to 3.'),
      })
      .strict(),
  },
  {
    name: 'create_session',
    description:
      'Creates one worker session (#13). Use it when there is no suitable session to assign work to — the created session appears right away in the list the person sees. Deleting it is the person\'s job.',
    schema: z.object({
      project: z
        .string()
        .optional()
        .describe('Project name or id.'),
      /*
       * Deliberately the same union the rest of the app uses, not a copy of it. A second
       * literal here could fall behind and the orchestrator would be unable to name a tool
       * that exists — a failure with no error, only an option that is never offered.
       *
       * Note the coupling runs both ways: if `ToolName` ever opens up (#74), this schema
       * widens with it. That is a decision to make there, with the injection surface in
       * view, not something to discover here.
       */
      tool: ToolName.optional().describe("If omitted, the project's default tool."),
      name: z.string().optional().describe('Session name. If given, the automatic name does not override it.'),
      firstMessage: z.string().optional().describe('The first instruction to send as soon as it is created.'),
      // #1233: work handed out is work whose end is heard, as start_agent's is; false opts out
      reportBack: z.boolean().optional().describe('With firstMessage: false if you do not need to hear when that first turn ends.'),
    }),
  },
  {
    /*
     * #694. A rare command (RARE_COMMANDS): asked for a few times in a seat's life, so it costs its line in
     * centralu_commands, not a definition in every request. Who may hand off what is HandoffFlow's (handoff-flow.ts).
     */
    name: 'handoff_session',
    description:
      'Hands a session off to a fresh one that starts from a note: built from its stored conversation by default, or written by the session (mode "agent"). ' +
      'Its live children move to the new session; the original stays. Refused while it is mid-turn; asks the person unless you are auto.',
    schema: z.object({
      sessionId: z.string().optional().describe('The session id from list_sessions.'),
      tool: ToolName.optional().describe("The new session's tool. If omitted, the same tool."),
      mode: z.enum(['record', 'agent']).optional().describe('Where the note comes from. record (default) asks the session nothing.'),
      instructions: z.string().optional().describe('Extra words for the new session, read after the note.'),
      waitFor: z.string().optional().describe('The handle a "still running" answer gave: waits on that handoff.'),
    }),
  },
  {
    name: 'propose_skill',
    description:
      '**Proposes** a reusable working procedure (a skill) to the person (#71) — when you keep getting the same request, or discover a way of working unique to this user. ' +
      "This tool saves nothing (the propose rule). If the person approves, the skill is saved to the app's database and " +
      'this session restarts; from then on it is always carried in the role prompt. A hook (automatic execution on an event) is not a skill — do not propose one.',
    schema: z.object({
      name: z.string().describe('Skill name (for example, weekly-report). Alphanumeric characters, hyphens, and underscores, 32 characters or fewer.'),
      content: z.string().describe('The body of the procedure (2,000 characters or fewer). When to use it, plus the steps. Keep only the essentials — it is always carried in the system prompt.'),
      why: z.string().optional().describe('A short note on why it is needed — the basis on which the person judges whether to approve it.'),
    }),
  },
  {
    name: 'propose_mcp_server',
    description:
      '**Proposes** installing an MCP server to the person — when a capability like browser automation (Playwright) is needed. ' +
      'This tool installs nothing (the propose rule). If the person approves, that server becomes a user-folder app and ' +
      'this session restarts — after the restart, its tools appear under the `app-<name>` server.',
    schema: z.object({
      /*
       * The character rule is only written down here for reference — the decision is made in the
       * one place, mcpServerNameError (#93). Pinning a regex into the schema too would create two
       * copies of the rule, and whichever one is looser becomes the hole.
       */
      name: z.string().describe('Server name (for example, playwright) — lowercase letters, digits, and hyphens, 32 characters or fewer. Becomes the tool prefix.'),
      command: z.string().describe('The command to run (for example, npx).'),
      args: z.array(z.string()).default([]).describe('Command arguments (for example, ["-y", "@playwright/mcp@latest"]).'),
      why: z.string().optional().describe('A short note on what it is needed for — the basis on which the person judges whether to approve it.'),
    }),
  },
  {
    name: 'check',
    description:
      'Checks the app you are building (M4 C-3) — call it after making a change. It restarts the app from the current files, actually calls the tool list, ' +
      "reads the screen (ui://) a tool points to, and looks at the manifest, tool names (\"__\" is forbidden), visibility, readOnlyHint, and the home tool's screen. " +
      "It returns any problems and the app's stderr as text. It does not cut off a call in progress (it waits for it to finish).",
    schema: z.object({}),
  },
  {
    name: 'create_app',
    description:
      'Creates a new app (a Centralu app) from a template (M4) — use it when the person says "make me a tool/screen that does…". An app is a small MCP server that ' +
      'the person clicks as a screen and an agent calls as the same tools, as functions. If project is given, it is created inside that project ' +
      '(`.centralu/apps/<id>/`, committed to the repository and shared with the team); if not, it becomes a new project of its own, a folder <parent>/<id> ' +
      '(~/Centralu unless parent is given) whose root is the app, after the person allows it on a card. It can only be created in a trusted project, and an id that already exists is ' +
      "not overwritten. Deleting it is the person's job.",
    schema: z.object({
      /*
       * The character rule is only written down here for reference — the decision is made in the
       * one place, the runtime's door (`createApp`) (#93).
       */
      id: z.string().describe('App id (for example, resource-search) — lowercase letters, digits, and hyphens, 32 characters or fewer, and must not start with "centralu" or "app-". Becomes both the folder name and the session\'s server name app-<id>.'),
      name: z.string().describe('The name shown to the person (for example, Resource Search).'),
      project: z.string().optional().describe('Project name or id. If omitted, a new project that is the app.'),
      parent: z.string().optional().describe('Without project: the full path of the folder its folder goes in. ~/Centralu if omitted.'),
      description: z.string().optional().describe('One line on what the app does.'),
      tool: ToolName.optional().describe("The tool for the building session. If omitted, the project's default tool."),
    }),
  },
] as const

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number]['name']

/**
 * The tool of an app's building session (M4 C-3) — one, a check of its own app. The orchestrator
 * does not have it: checking means spinning up the app and running its code, and the calling
 * session must decide which app it is (the app it is building) — there is no way to spin up
 * someone else's app by name.
 */
export const BUILDER_TOOL_NAMES = ['check'] as const satisfies readonly OrchestratorToolName[]

/**
 * The light set every ordinary session gets (#320) — read-only; since #984 a trusted project's reads every project and linked machine.
 *
 * **Its own definitions, not the orchestrator's text.** The names and the execution are shared
 * (runOrchestratorTool), but the orchestrator's descriptions talk about managing, reportBack and
 * send_to_session — a role this seat does not have, and words an ordinary session would read as
 * a hint to start directing. They are also the cost: these schemas ride in every session's
 * context on every turn, so each word was weighed against a measurement (haiku, CLI 2.1.289,
 * scripts/probe-reader-tools.mts; the table is in docs/agent-host.md):
 *
 *   - Each tool costs about 55 tokens before its first word (its name and schema envelope:
 *     list_sessions, with no arguments and a one-line description, cost 75), so the tool that
 *     earned least was merged rather than trimmed: listing is read_session without a sessionId.
 *     The four candidates re-worded cost +338 tokens; merged, +267. Asked about the project's
 *     other sessions, the model called read_session with no id (5 of 5).
 *   - app_guide is deferred behind tool search (`deferred` below; Claude only — Codex has no
 *     deferral and gets it loaded): it is the one a session rarely needs, and it is 75 of those
 *     tokens (+192 with it deferred). Asked how to do something in Centralu, the model found it
 *     through tool search 4 of 5 times (5 of 5 loaded); the miss is an answer from a guess, and
 *     the orchestrator still has the guide loaded. Deferring the whole set was measured and
 *     refused: recall was never called (asked about an earlier conversation, the model said it
 *     had no memory), the same failure the orchestrator measured for send_to_session.
 *   - What is left out of the schemas still runs (read_session's `limit` and `tools`, recall's
 *     `limit`): the runner reads the same arguments for every profile, and the defaults are what
 *     a session wants nearly every time. `around` goes unexplained: recall's own answer spells
 *     out the call (`read_session(sessionId=…, around=…)`).
 *
 * Short instructions go with this set (READER_INSTRUCTIONS, #564): use Centralu's tools first unless the person
 * says otherwise. Until 2026-10-12 it had none, on the principle that Centralu offers tools to the person's
 * sessions and does not direct them (product-spec.md §1.2); the owner reversed that. They still carry no role:
 * the session stays an ordinary session, and they only say which tool answers which need.
 */
export const READER_TOOLS = [
  {
    name: 'update_centralu',
    // "apply" (#665) needs no words of its own here: 8 characters in every reader's request, and the install answer names it
    description: 'Updates Centralu with consent.',
    schema: z.object({ action: UPDATE_ACTION }),
    // Updates are rare (#581); keep the definition behind Claude's tool search like app_guide.
    deferred: true,
  },
  {
    name: 'read_session',
    description: 'Reads another Centralu session. No sessionId: lists them (project narrows).',
    schema: z.object({ sessionId: z.string().optional(), around: z.number().optional(), project: z.string().optional() }),
  },
  {
    name: 'recall',
    description: 'Searches all past conversations. One word works best.',
    schema: z.object({ query: z.string() }),
  },
  {
    name: 'app_guide',
    description: "Centralu's user guide. Read it before answering how Centralu works.",
    // An enum (#523): as a free string the model named a topic in its own words and the first call failed (1 of 4 worked on Claude; 15 of 15 since)
    schema: z.object({ topic: z.enum(APP_GUIDE_TOPICS).optional() }),
    deferred: true,
  },
] as const satisfies readonly { name: OrchestratorToolName; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

/**
 * Delegation to another project (#371 part B) — the one tool that reaches outside an ordinary session's project, so
 * it is its own set with its own budget rather than a fourth reader. It rides with the reader set (the same profile,
 * the same Settings switch), and it acts only after the person's consent for the pair of projects: the consent card,
 * not this description, is what keeps the project boundary.
 *
 * Loaded, not deferred: like recall, it answers a request the person makes in words ("have the other project do
 * it"), and a tool the model has to search for first is one it may answer without (#320 measured that for recall).
 * `task` is optional only for waiting: the "still working" answer tells the model to call again without one.
 *
 * The last sentence points away from it (#522): asked about another project's app, the model reached for this, the
 * loaded tool naming "another Centralu project", and never searched for find_apps. With it and find_apps loaded,
 * 9 of 10 runs went on to attach_app, against 0 of 10 before (docs/tool-cost.md §8).
 */
export const DELEGATE_TOOLS = [
  {
    name: 'ask_project',
    description: "Asks another project's existing session; returns its answer. For another project's apps, use find_apps.",
    /*
     * ifBusy (#677): a busy session returns its choices, and that answer names this argument and its values ("note",
     * "queue"), so it needs no words or enum here: this definition rides in every ordinary Claude request (the
     * reader's 2,300 there), and the runner refuses any other value.
     */
    schema: z.object({ project: z.string(), session: z.string().optional(), task: z.string().optional(), ifBusy: z.string().optional() }),
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

/**
 * The ceiling for DELEGATE_TOOLS, counted the same way as READER_BUDGET_CHARS. The set is measured in docs/agent-host.md.
 * 400 until #677's `ifBusy` (a bare string: a busy session's answer names the argument and its values).
 */
export const DELEGATE_BUDGET_CHARS = 450

/**
 * Other agents in the same project (#561) — an ordinary session starts a Claude or Codex session on a task and works
 * with it. Its own set with its own budget, like ask_project's, because it acts: the consent card, the caller's
 * preset as the child's ceiling, the agent depth (#867) and the per-project count are the manager's (`startAgent`), not words here.
 *
 * Two tools, as the issue proposed: starting is the request a person makes in words ("have Codex write it"), so it is
 * loaded; working with a child already started is reached from start_agent's own answer, which names agent_session,
 * so on Claude it waits behind tool search (the attach_app pattern, #522). `name` (#861): six children named from their
 * tasks' first words read alike in the sidebar; a short name the caller gives is the name and the branch, and without
 * one the name skips the words the task shares with its siblings. No description: each word rides in every request.
 */
export const AGENT_TOOLS = [
  {
    name: 'start_agent',
    description: 'Has a new agent session in this project do a job; returns its answer.',
    schema: z.object({
      task: z.string(),
      tool: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      /*
       * #729: the person picks a model per tool and difficulty in Settings, so a caller says how hard the job is and
       * needs no model names. The guidance is here, not in an answer, because it is needed before the first call; the
       * words cost every request (AGENT_BUDGET_CHARS)
       */
      difficulty: AgentDifficulty.optional().describe('Instead of model. light: lookups, small fixes, reviews; heavy: design, security, data loss.'),
      wait: z.boolean().optional().describe('false: do not wait; you are told when it ends.'),
      /*
       * A new worktree (#561 part 2): a boolean and a name rather than a workspace enum, each cheaper and either alone
       * enough (a branch implies the worktree; without one the branch is named from the job). When to ask for one is
       * #729's guidance: a worktree for work that ends in a pull request or runs beside other edits; none for research
       * or for edits the person watches live in their own checkout (UI work under a dev server)
       */
      worktree: z.boolean().optional().describe('For PR-bound edits; not research or edits watched live.'),
      branch: z.string().optional(),
      /*
       * Code intelligence (#686): a child starts without its CLI's language server unless this is true. No description:
       * each word rides in every request (AGENT_BUDGET_CHARS), and the answer that matters, when to ask for it, is the
       * caller's call per task (refactors and wide cross-file changes)
       */
      lsp: z.boolean().optional(),
      name: z.string().optional(),
      /*
       * A linked machine to start it on (#1038), in its checkout of this repository. No description: the answer that
       * refuses names the machines and what is missing, and each word rides in every request (AGENT_BUDGET_CHARS)
       */
      machine: z.string().optional(),
    }),
  },
  {
    name: 'agent_session',
    /*
     * "answer" (#676): a card of the turn the caller gave, which status shows; `card` only when more than one stands.
     * Not in the description: the answer that shows a card names the call, and the description rides in every request.
     */
    description: 'Lists, checks, messages, waits for, stops or deletes sessions start_agent started.',
    schema: z.object({
      // Not needed for "list" (#690): the caller's own children, so a parent that forgot one finds it in one call
      sessionId: z.string().optional(),
      action: z.enum(['status', 'send', 'wait', 'stop', 'delete', 'answer', 'list']),
      text: z.string().optional(),
      card: z.string().optional(),
      // #677: send to a busy session returns its choices, which name this argument
      ifBusy: IF_BUSY.optional(),
    }),
    deferred: true,
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

/**
 * The ceiling for AGENT_TOOLS, counted like READER_BUDGET_CHARS (both tools, since Codex loads them). Measured in
 * docs/tool-cost.md. 1,000 until #676/#677 gave agent_session `answer`, `card` and `ifBusy` (1,060 with them, no words
 * added: the answers that need them name them). Claude defers agent_session, so its every request does not carry them.
 * 1,100 until #729: start_agent's `difficulty` and the words on it and on `worktree` (551 → 798 characters, the set
 * 1,085 → 1,332), loaded on Claude, so every ordinary Claude request carries the 247: 68 tokens, measured live
 * (docs/tool-cost.md §10). Guidance a caller needs before
 * its first call has no answer to ride in. #690's `list` made the set 1,333 (agent_session 534 → 535, deferred on Claude).
 * 1,350 until #861's `name` (a bare string, 25 characters: the set 1,333 → 1,358). 1,375 until #1038's `machine` (a bare
 * string, as `name`).
 */
export const AGENT_BUDGET_CHARS = 1400

/**
 * Another project's app tools, on demand (#371 part A) — rides with the reader set, so a project's
 * ordinary session has it, and is counted against its own ceiling below (READER_TOOLS keeps #320's).
 *
 * Three tools rather than one with a mode: each one's schema is a single string, and the model picks a
 * verb by name. On Claude (Codex loads them all) find_apps is loaded and the other two wait behind
 * tool search: the result of each one names the next (`find_apps` says "attach_app", `attach_app`
 * says "detach_app"), so a model that found the first finds the rest (docs/apps.md §9.4).
 *
 * find_apps was deferred too until #522: asked about another project's app without being told to use
 * it, haiku never searched for it (0 of 10 runs called attach_app) and called the loaded ask_project.
 * Loaded, with ask_project's pointer to it, 9 of 10 called attach_app (8 of 10 in a second run); it
 * costs +75 tokens in every ordinary Claude session's request, the pointer +11. Loading attach_app as
 * well (+155 in all) did worse, 7 of 10. The comparison of every variant is in docs/tool-cost.md §8.
 */
export const APP_ACCESS_TOOLS = [
  {
    name: 'find_apps',
    description: "Finds Centralu apps from the person's other projects that this session can attach.",
    schema: z.object({ query: z.string().optional() }),
  },
  {
    name: 'attach_app',
    description: 'Attaches an app find_apps listed to this session, adding its tools.',
    schema: z.object({ app: z.string() }),
    deferred: true,
  },
  {
    name: 'detach_app',
    description: 'Detaches an app attach_app added, removing its tools.',
    schema: z.object({ app: z.string() }),
    deferred: true,
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

export type AppAccessToolName = (typeof APP_ACCESS_TOOLS)[number]['name']

/** start_agent and agent_session (#561), which the orchestrator reaches as commands too (#853) */
export type AgentToolName = (typeof AGENT_TOOLS)[number]['name']

/**
 * The ceiling for the app-access set, counted like READER_BUDGET_CHARS (full name, description and
 * schema; the deferred ones included, since Codex loads them). The set is 874 today, of which about
 * 210 per tool is the name and schema envelope rather than words — why it is three short tools and
 * not three explained ones. Claude loads find_apps (294 characters, 75 tokens) and defers the other
 * two, which cost their names in tool search only.
 */
export const APP_ACCESS_BUDGET_CHARS = 900

/**
 * Repository work by hand (#957 follow-up, owner decision 2026-10-17): an attached app such as the project board serves
 * its task-to-tool table on demand from its own guide (its `help` tool), never in these instructions, which sit in
 * the prompt's cached prefix and must not change when an app is added or changed (#512). This one line, the same
 * whichever apps they are, sends an agent to that guide before it reaches for `gh` or `git` by hand.
 *
 * Only in an ordinary session that has an app attached when it starts (#992 review): without one there is no help to
 * read, and the 88 characters would ride in every request for nothing. Decided once, at the start, so the session's
 * prefix never changes under it; an app attached later is found through its tools. Not the orchestrator's: it does
 * no repository work itself ("You have no hands").
 */
export const REPO_WORK_FIRST = "an attached app's help tool before repository work by hand (PRs, CI, merges, releases)"

/**
 * What an ordinary session reaches for first, one need per entry (#564). A tool that joins the reader seat and
 * answers a need the person states in words adds its line here. Every entry rides in every ordinary session's
 * every request, on Claude as the server's instructions and on Codex in the thread's developer instructions
 * (codexToolInstructionsFor); the cost and the selection with and without them are in docs/tool-cost.md §11.
 */
export const READER_FIRST: readonly string[] = [
  'recall for earlier conversations',
  'read_session for other sessions',
  "find_apps to use another project's app",
  'update_centralu to update Centralu',
  'ask_project to have another project do work',
  /*
   * #561's tool. Owner decision (2026-10-12, option B): the CLI's own subagents stay the way to hand off short helper
   * work inside the turn; start_agent is for work that runs in another CLI or a worktree, runs long, or that the person
   * will follow. Naming the Agent tool is what moved the choice (docs/tool-cost.md §11).
   */
  'start_agent, not your Agent tool, for long work, another CLI or a worktree, or work the person will follow',
]

/**
 * The reader set's instructions (#564): the product rule (product-spec.md §1.2), worded as needs rather than as a
 * role. "Unless the person says otherwise" is the rule's own limit: a direct instruction wins.
 */
export const READER_INSTRUCTIONS = `You are running inside Centralu. Unless the person says otherwise, use its tools before other ways of doing the same: ${READER_FIRST.join('; ')}.`

/** The same with REPO_WORK_FIRST, for an ordinary session that starts with an app attached (#957, #992 review) */
export const READER_INSTRUCTIONS_WITH_APPS = `You are running inside Centralu. Unless the person says otherwise, use its tools before other ways of doing the same: ${[...READER_FIRST, REPO_WORK_FIRST].join('; ')}.`

/**
 * The ceiling for the reader set, in characters of what the model is sent: each tool's full name,
 * description and JSON schema, plus the instructions, including the deferred guide and update
 * definitions since Codex can load them. Measured for #581: 1,709 = 983 existing tool characters
 * + 298 for update_centralu + 428 instructions (392 before its 36-character pointer).
 * The ceiling rises from 1,400 to 1,750 for that addition. On Claude the update definition is
 * deferred: only the pointer rides in every request. The tokens measured for the earlier
 * instructions remain in docs/tool-cost.md §11; these new figures count characters, not tokens.
 * Raising it is a decision about every session's context: a line added to READER_FIRST counts here. #957's
 * REPO_WORK_FIRST is not counted: it rides only where an app is attached, whose own tools cost more than it.
 */
export const READER_BUDGET_CHARS = 1750

/**
 * The ceiling for what each profile carries in every request (#513), in characters of its resident
 * definitions plus the server instructions the model is sent (`residentCost` in tool-cost.ts), in the default
 * rare-commands tier. Measured 2026-10-12 on Claude: orchestrator 9,317 in the commands tier (7,323 + 1,994; it
 * was 11,862 with every command resident, against a ceiling of 12,000, before the tier became the default, #512),
 * scoped 2,267, builder 1,432; the tokens they cost are in docs/tool-cost.md.
 * Codex carries the same plus the 52-character
 * header its developer instructions put over them (#525, codexToolInstructionsFor), which is what moved scoped
 * from 2,300 and builder from 1,450. The reader is the sum of its four sets' ceilings (#561 added the agent set).
 * Measured for #581: Claude 2,295 resident (1,867 definitions + 428 instructions), with 1,673 deferred;
 * Codex's possible loaded set 4,020 (3,540 definitions + 480 instructions), with none marked deferred.
 * Its ceiling rises from 3,700 to 4,050, covering the loaded set including Codex's header.
 * Like READER_BUDGET_CHARS, raising one is a decision about that seat's every request. The worktree manager's
 * seat went with the role (#561 part 3). Scoped rises from 2,350 to 2,400 for send_to_session's `ifBusy` (#677, an
 * enum with no words: 2,330 on Claude, 2,382 on Codex); nothing makes a new coordinator since #372.
 * The reader rises with AGENT_BUDGET_CHARS for #729 (4,200 → 4,450): Claude 2,313 → 2,560, Codex 4,150 → 4,397.
 */
export const RESIDENT_BUDGET_CHARS: Record<ToolProfile, number> = {
  orchestrator: 9_500,
  scoped: 2_400,
  builder: 1_500,
  reader: READER_BUDGET_CHARS + DELEGATE_BUDGET_CHARS + AGENT_BUDGET_CHARS + APP_ACCESS_BUDGET_CHARS,
}

/** The building session's MCP guide — the role (the app's place and rules) is applied by roleAppend */
export const BUILDER_INSTRUCTIONS = [
  "You are the session that builds one Centralu app. This server's check inspects your app.",
  'After changing an app file, call check to confirm the result — do not leave testing to the person.',
  'If there is a problem, fix it and call check again. Once it passes, tell the person in one line what you changed.',
  /*
   * The theme (#312 step 6). Recommended, never checked (owner decision 7): a screen that ignores
   * it still works, it only stops matching the person's theme.
   */
  "Style the screen with the theme Centralu sends (the MCP Apps style variables and Centralu's own, applied by the template's applyTheme), each with a fallback, instead of fixed colours, so it follows the person's light or dark theme. Keep the template's scrollbar stylesheet. Use --color-text-warning only for what waits on the person.",
  /* Narrow first (#306, option B): a panel on the grid is about 360-480px wide unless the person gives it more cells (option C). */
  'Build the screen to work in a narrow grid panel (about 360px) first and spread out when there is room: no wide fixed widths, rows that wrap, side-by-side parts stacked below about 520px.',
].join('\n')

/** The instructions given to the model — travels together with the tool list */
export const ORCHESTRATOR_INSTRUCTIONS = [
  'A tool for handling the sessions this app (Centralu) manages.',
  'For a question that crosses projects or spans several sessions, look at the current state with list_sessions first.',
  'Use send_to_session to assign work — the target session\'s approval settings apply as they are,',
  'so a risky action will make that session ask the person for approval.',
  'If the person is waiting for the result, turn on reportBack — it notifies you here when that session finishes.',
  // #1233: work handed out is heard of when it ends; more words into it do not undo that
  "create_session's firstMessage reports back the same way unless reportBack is false; a note into a running turn never cancels a report.",
  'If a report is not enough, read that session\'s conversation directly with read_session.',
  'If there is no suitable session to assign work to, make one with create_session — deleting it is the person\'s job.',
  // #853: the orchestrator's light work outside any project went to its CLI's own subagent, which Centralu never shows
  'For light work outside any project (a web search, a lookup), start a session the person can watch with the start_agent command, not your Agent tool.',
  'Make a new project with create_project; add an existing folder, here or on a linked machine, with the add_project command (list_machines names the machines).',
  // #1219: the machine and trust commands (#1219's third slice: projects' trust, approval rules, app grants, agent limits) are found by these words
  'Machines and trust: centralu_commands "machine trust rule grant limits". Settings: get_preferences, set_preferences. Trash: list_trash.',
  'When the person says "make me a tool/screen that does…", make the app with create_app — a screen the person clicks and the tools an agent calls are one app.',
  // #1205: one server per trusted project that is an app grew every request; the orchestrator attaches the one it needs
  'Projects that are apps attach on demand: the find_apps command lists them.',
  'If a new capability like browser automation is needed, **propose** it with propose_mcp_server — if the person approves, the app installs it and restarts you. The conversation continues after the restart.',
  'If you keep getting the same request, or discover a way of working unique to this user, **propose** a procedure with propose_skill — an approved skill is always carried in your role from then on.',
  'To replace a session that has drifted, or move its work to the other CLI, hand it off with handoff_session.',
  'If you do not know the answer to a question about the app, do not guess; point to a GitHub issue: https://github.com/ijun17/centralu/issues',
  'Putting the seq recall gave into read_session\'s around jumps straight to the spot you found — it does not read the whole session.',
  'When something like "last time" or "back then, over there" comes up, look for the past conversation with recall —',
  'the conversation you had with the person is the memory that crosses projects, and that memory is reached only by search.',
].join('\n')

/** The shape the bridge (a separate process) can put into tools/list */
/**
 * The base tools for a scoped coordinating session (#80/#81, physically). There is no notion of
 * "duty" here — this bundle is only the capability "can see and instruct the sessions in the
 * allow-list," and the role is applied by the caller through roleAppend.
 * The absence of a session-creation tool is the depth-1 structural guarantee: a coordinator
 * cannot create a coordinator.
 */
export const SCOPED_TOOL_NAMES = [
  'list_sessions',
  'read_session',
  'send_to_session',
] as const satisfies readonly OrchestratorToolName[]

/** The MCP guide for a coordinating session — the role is applied by roleAppend, so this only states the boundary of its capability */
export const SCOPED_INSTRUCTIONS = [
  'You are a coordinating session that can only see and direct its assigned member sessions.',
  'What list_sessions shows is the whole of your view — you cannot even ask whether a session outside it exists.',
  'Use send_to_session to assign work to a member, and reportBack or read_session to check the result.',
  'You cannot create or delete a session — report to the person if that is needed.',
].join('\n')

/**
 * The three fixed tools of the `commands` tier (#512). Short on purpose: they ride in every request in place
 * of the commands' own definitions. `command` is a string, not an enum of the commands: an enum would put
 * the names back in every request and change the prefix whenever a command is added, which is what this
 * tier is for.
 */
export const COMMAND_TOOLS = [
  {
    name: 'centralu_commands',
    description: 'Lists the Centralu commands not in your tool list, one line each. query narrows it.',
    schema: z.object({ query: z.string().optional() }),
  },
  {
    name: 'centralu_help',
    description: "One Centralu command's description and its arguments' schema.",
    schema: z.object({ command: z.string() }),
  },
  {
    name: 'centralu_run',
    description: 'Runs a Centralu command. args must match its schema (centralu_help).',
    schema: z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[]

export type CommandToolName = (typeof COMMAND_TOOLS)[number]['name']

type ToolDef = { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }

/** A set of definitions as a table of their schemas by name, keeping each one's type */
function schemasOf<const D extends readonly ToolDef[]>(defs: D): { [T in D[number] as T['name']]: T['schema'] } {
  return Object.fromEntries(defs.map((d) => [d.name, d.schema])) as { [T in D[number] as T['name']]: T['schema'] }
}

const ORCHESTRATOR_ARGS = schemasOf(ORCHESTRATOR_TOOLS)

/**
 * Each tool's arguments, one schema per tool (#850), read once by runOrchestratorTool on every path and by centralu_run
 * strictly. A tool's own definition is its schema wherever the definition shows all of it; the definitions some seats
 * are shown leave arguments out to save words in every request (READER_TOOLS, DELEGATE_TOOLS), and the runner takes
 * the full set from here, so a seat shown fewer still has the rest run the same way (the test holds the shown keys to
 * these).
 */
export const TOOL_ARGS = {
  ...ORCHESTRATOR_ARGS,
  /*
   * The reader lists with read_session and no id (#320, READER_TOOLS); the other seats are shown it required. `offset`
   * (#1186) is shown to no seat: a line cut, and ask_project's cut, spell out the read that uses it, as recall does `around`
   */
  read_session: ORCHESTRATOR_ARGS.read_session.partial({ sessionId: true }).extend({ project: z.string().optional(), offset: z.number().int().min(0).optional() }),
  ...schemasOf(AGENT_TOOLS),
  /*
   * The topic is an enum in the definition (#523), but the guide reads a topic named in other words as the nearest one
   * and answers an unknown one with the list (appGuide): on a path no schema checked, that reading is the answer
   */
  app_guide: ORCHESTRATOR_ARGS.app_guide.extend({ topic: z.string().optional() }),
  // ifBusy is a bare string in the definition (#677: the busy answer names its values); the runner takes these two
  ask_project: DELEGATE_TOOLS[0].schema.extend({ ifBusy: z.enum(['note', 'queue'] as const satisfies readonly IfBusy[]).optional() }),
  ...schemasOf(APP_ACCESS_TOOLS),
  ...schemasOf(COMMAND_TOOLS),
  // Codex's exec may hand a command's arguments over as JSON text rather than an object: centralu_run reads either
  centralu_run: COMMAND_TOOLS[2].schema.extend({ args: z.union([z.record(z.string(), z.unknown()), z.string()]).optional() }),
}

/** The fixed line the `commands` tier adds to the seat's instructions (#512): the tools alone were not a promise the model would look */
export const COMMANDS_INSTRUCTION =
  'Some commands, among them those named above, are not in your tool list: centralu_commands lists them, centralu_help gives one\'s arguments, centralu_run runs it.'
