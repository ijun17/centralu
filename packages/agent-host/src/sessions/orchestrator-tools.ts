import { z } from 'zod'
import { ToolName } from '@cc/protocol'
import type { ChildRunResult, AskProjectResult, OrchestratorTools } from '../adapters/contract.js'
import { ORCHESTRATOR_MCP_NAME, type ToolCaller, type ToolOutput, type ToolProfile } from '../apps/contract.js'
import { appGuide, APP_GUIDE_TOPICS, type GuideSeats, type GuideTool } from './app-guide.js'

/**
 * Someone else's text as one JSON string on one line (#121). JSON.stringify escapes every control character but
 * leaves U+2028 and U+2029, which a reader may take for line breaks; they are escaped too.
 */
export function trustedJsonText(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/*
 * The server name and the naming rule moved to the app runtime contract (M4 A-1) — an external
 * app's id follows the same rule (`app-<id>` becomes the server name attached to the session),
 * and the runtime cannot import this layer (sessions). The existing consumers (the two adapters
 * and the manager) still import it from here unchanged.
 */
export { ORCHESTRATOR_MCP_NAME, mcpServerNameError, proposedMcpServerNameError } from '../apps/contract.js'

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
    description: 'Checks for or installs a Centralu update. Installing never changes the person\'s automatic-update setting.',
    schema: z.object({ action: z.enum(['check', 'install']) }),
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
    }),
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
     * choosing between pointing and doing, and the set does not grow. Adding a folder that already exists stays the
     * person's (the folder picker is theirs); the instructions say where to send them. Kept short: it rides in every orchestrator request (RESIDENT_BUDGET_CHARS).
     */
    name: 'create_project',
    description:
      "Makes a new project: an empty folder, or a clone of git, in ~/Centralu or in parent. The person approves it on a card first; " +
      'the call waits for the answer. An existing folder is never reused.',
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
      '(`.centralu/apps/<id>/`, committed to the repository and shared with the team); if not, it is created in the user folder (an app used across several projects). It can only be created in a trusted project, and an id that already exists is ' +
      "not overwritten. Deleting it is the person's job.",
    schema: z.object({
      /*
       * The character rule is only written down here for reference — the decision is made in the
       * one place, the runtime's door (`createApp`) (#93).
       */
      id: z.string().describe('App id (for example, resource-search) — lowercase letters, digits, and hyphens, 32 characters or fewer, and must not start with "centralu" or "app-". Becomes both the folder name and the session\'s server name app-<id>.'),
      name: z.string().describe('The name shown to the person (for example, Resource Search).'),
      project: z.string().optional().describe('Project name or id. If omitted, a user-folder app.'),
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
 * The light set every ordinary session gets (#320) — read-only, and only its own project.
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
    description: 'Updates Centralu with consent.',
    schema: z.object({ action: z.enum(['check', 'install']) }),
    // Updates are rare (#581); keep the definition behind Claude's tool search like app_guide.
    deferred: true,
  },
  {
    name: 'read_session',
    description: "Reads one of this project's other Centralu sessions. No sessionId: lists them.",
    schema: z.object({ sessionId: z.string().optional(), around: z.number().optional() }),
  },
  {
    name: 'recall',
    description: "Searches this project's past conversations. One word works best.",
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
    description: "Has another Centralu project do a job in its own folder; returns its session's answer. For another project's apps, use find_apps.",
    schema: z.object({ project: z.string(), task: z.string().optional() }),
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

/** The ceiling for DELEGATE_TOOLS, counted the same way as READER_BUDGET_CHARS. The set is measured in docs/agent-host.md */
export const DELEGATE_BUDGET_CHARS = 400

/**
 * Other agents in the same project (#561) — an ordinary session starts a Claude or Codex session on a task and works
 * with it. Its own set with its own budget, like ask_project's, because it acts: the consent card, the caller's
 * preset as the child's ceiling, depth one and the per-project count are the manager's (`startAgent`), not words here.
 *
 * Two tools, as the issue proposed: starting is the request a person makes in words ("have Codex write it"), so it is
 * loaded; working with a child already started is reached from start_agent's own answer, which names agent_session,
 * so on Claude it waits behind tool search (the attach_app pattern, #522). No `name` argument: the child is named from
 * its task, and the person renames it; each argument rides in every request.
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
      wait: z.boolean().optional().describe('false: do not wait; you are told when it ends.'),
      // A new worktree (#561 part 2): a boolean and a name rather than a workspace enum, each cheaper and either alone
      // enough (a branch implies the worktree; without one the branch is named from the job)
      worktree: z.boolean().optional(),
      branch: z.string().optional(),
    }),
  },
  {
    name: 'agent_session',
    description: 'Checks, messages, waits for, stops or deletes a session start_agent started.',
    schema: z.object({ sessionId: z.string(), action: z.enum(['status', 'send', 'wait', 'stop', 'delete']), text: z.string().optional() }),
    deferred: true,
  },
] as const satisfies readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[]

/** The ceiling for AGENT_TOOLS, counted like READER_BUDGET_CHARS (both tools, since Codex loads them). Measured in docs/tool-cost.md */
export const AGENT_BUDGET_CHARS = 1000

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

/**
 * The ceiling for the app-access set, counted like READER_BUDGET_CHARS (full name, description and
 * schema; the deferred ones included, since Codex loads them). The set is 874 today, of which about
 * 210 per tool is the name and schema envelope rather than words — why it is three short tools and
 * not three explained ones. Claude loads find_apps (294 characters, 75 tokens) and defers the other
 * two, which cost their names in tool search only.
 */
export const APP_ACCESS_BUDGET_CHARS = 900

/**
 * What an ordinary session reaches for first, one need per entry (#564). A tool that joins the reader seat and
 * answers a need the person states in words adds its line here. Every entry rides in every ordinary session's
 * every request, on Claude as the server's instructions and on Codex in the thread's developer instructions
 * (codexToolInstructionsFor); the cost and the selection with and without them are in docs/tool-cost.md §11.
 */
export const READER_FIRST: readonly string[] = [
  'recall for earlier conversations',
  "read_session for this project's other sessions",
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

let readerInstructions = true

/**
 * `CC_READER_INSTRUCTIONS=0` (read once at start, main.ts): ordinary sessions get their tools without the
 * instructions, as before #564. For measuring the instructions against their absence; on by default.
 */
export function setReaderInstructions(on: boolean): void {
  readerInstructions = on
}

/**
 * The ceiling for the reader set, in characters of what the model is sent: each tool's full name,
 * description and JSON schema, plus the instructions, including the deferred guide and update
 * definitions since Codex can load them. Measured for #581: 1,709 = 983 existing tool characters
 * + 298 for update_centralu + 428 instructions (392 before its 36-character pointer).
 * The ceiling rises from 1,400 to 1,750 for that addition. On Claude the update definition is
 * deferred: only the pointer rides in every request. The tokens measured for the earlier
 * instructions remain in docs/tool-cost.md §11; these new figures count characters, not tokens.
 * Raising it is a decision about every session's context: a line added to READER_FIRST counts here.
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
 * seat went with the role (#561 part 3).
 */
export const RESIDENT_BUDGET_CHARS: Record<ToolProfile, number> = {
  orchestrator: 9_500,
  scoped: 2_350,
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
  'If a report is not enough, read that session\'s conversation directly with read_session.',
  'If there is no suitable session to assign work to, make one with create_session — deleting it is the person\'s job.',
  'Make a new project with create_project; to add an existing folder, point the person to Add project in the sidebar.',
  'When the person says "make me a tool/screen that does…", make the app with create_app — a screen the person clicks and the tools an agent calls are one app.',
  'If a new capability like browser automation is needed, **propose** it with propose_mcp_server — if the person approves, the app installs it and restarts you. The conversation continues after the restart.',
  'If you keep getting the same request, or discover a way of working unique to this user, **propose** a procedure with propose_skill — an approved skill is always carried in your role from then on.',
  'If you do not know the answer to a question about the app, do not guess; point to a GitHub issue: https://github.com/ijun17/centralu/issues',
  'Putting the seq recall gave into read_session\'s around jumps straight to the spot you found — it does not read the whole session.',
  'When something like "last time" or "back then, over there" comes up, look for the past conversation with recall —',
  'the conversation you had with the person is the memory that crosses projects, and that memory is reached only by search.',
].join('\n')

async function listSessionsText(tools: OrchestratorTools, caller: ToolCaller): Promise<ToolOutput> {
  const list = await tools.listSessions()
  if (list.length === 0) {
    return { text: caller.profile === 'reader' ? 'There are no other sessions in this project.' : 'There are no sessions under management.' }
  }
  return {
    text: list
      .map(
        (s) =>
          // A linked machine's session says where it runs (#82 phase 4), and why the row is only what was last known
          `- ${s.name} [${s.sessionId}] · project ${s.project}${s.machine ? ` on ${s.machine}` : ''} · ${s.tool} · ${s.state}` +
          (s.away ? ` · ${s.away}` : '') +
          // If merge status is not shown, the manager keeps assigning work to a finished branch (#69, dogfooding)
          (s.merged ? ' · merged' : '') +
          // PR status (#76 stage 3) — assigning new work to a branch awaiting review pollutes the PR
          (s.pr ? ` · PR #${s.pr.number}(${s.pr.state})` : '') +
          (s.lastActive ? ` · last ${s.lastActive}` : '') +
          (s.preview ? `\n    recent (JSON): ${trustedJsonText(s.preview)}` : ''),
      )
      .join('\n'),
  }
}

/**
 * What the model reads back from ask_project (#371). The delegated session's answer is someone else's words, so it
 * is fenced the way a worker's preview is (JSON-quoted, one line): a line in it cannot pose as a line of ours. The
 * session is named so the person can be pointed at it; the paths come last, as a list the model can act on.
 */
function askProjectText(r: AskProjectResult): ToolOutput {
  if (!r.ok) return { text: r.error, isError: true }
  const where = `the session "${r.sessionName}" [${r.sessionId}] in ${r.project}`
  if (r.state === 'working') {
    return {
      text:
        `${r.project} is still working on it in ${where}${r.notice ? ` — ${r.notice}` : ''}. ` +
        `To keep waiting, call ask_project again with project "${r.project}" and no task; the work goes on meanwhile.`,
    }
  }
  const lines = [`${r.project} answered (from ${where}), as JSON:`, trustedJsonText(r.answer || '(no final text)')]
  if (r.readable.length) lines.push(`You can read these now: ${r.readable.join(', ')}`)
  if (r.outside.length) lines.push(`Named outside ${r.project}'s folder (not opened for you): ${r.outside.join(', ')}`)
  return { text: lines.join('\n') }
}

/**
 * What the model reads back from start_agent and agent_session (#561). The child's answer is fenced like ask_project's
 * (JSON-quoted, one line): it is another session's words. Each state names the next call, which is how a model that
 * has only start_agent loaded finds agent_session.
 */
function agentRunText(r: ChildRunResult): ToolOutput {
  if (!r.ok) return { text: r.error, isError: true }
  const who = `the ${r.tool} session "${r.sessionName}" [${r.sessionId}]`
  switch (r.state) {
    case 'working':
      return {
        text:
          `${who} is working on it${r.notice ? ` — ${r.notice}` : ''}. ` +
          (r.reported ? 'You will be told when it ends; ' : '') +
          `agent_session(sessionId="${r.sessionId}", action="wait") waits for its answer, action="stop" stops it.`,
      }
    case 'stopped':
      return { text: `Stopped ${who}.` }
    case 'deleted':
      return {
        text:
          `Cleaned up ${who}: "${r.branch}" had landed on the trunk (${r.proof}), so its worktree and branch were removed and the session went to the trash. ` +
          'Tell the person in one line.',
      }
    case 'at_rest':
      return {
        text:
          `${who} is not working on anything you gave it (${r.sessionState}). Its last answer, as JSON:\n${trustedJsonText(r.answer || '(no final text)')}\n` +
          `agent_session(sessionId="${r.sessionId}", action="send", text=…) gives it more.`,
      }
    case 'done': {
      const lines = [`${who} answered, as JSON:`, trustedJsonText(r.answer || '(no final text)')]
      if (r.notice) lines.push(r.notice)
      if (r.readable.length) lines.push(`You can read these now: ${r.readable.join(', ')}`)
      if (r.outside.length) lines.push(`Named outside its folder (not opened for you): ${r.outside.join(', ')}`)
      lines.push(`agent_session(sessionId="${r.sessionId}", action="send", text=…) continues with it.`)
      return { text: lines.join('\n') }
    }
  }
}

/**
 * Runs one tool and turns the result into **text for the model to read**.
 *
 * Why rendering happens here too: if each of the two paths composed its own sentence, the same
 * result would look different. The judgment (what to give) lives in OrchestratorTools, the
 * presentation (how it looks) lives here.
 */
export async function runOrchestratorTool(
  tools: OrchestratorTools,
  name: string,
  args: Record<string, unknown>,
  caller: ToolCaller = { sessionId: null, profile: 'human' },
  /** The tool call's own signal, where the path has one (Claude's in-process MCP) — ask_project stops the delegated turn on it */
  signal?: AbortSignal,
): Promise<ToolOutput> {
  if (name === 'update_centralu') {
    const action = args.action
    if (action !== 'check' && action !== 'install') return { text: 'Give action: check or install.', isError: true }
    const r = tools.updateCentralu ? await tools.updateCentralu(action) : { ok: false, error: 'Update checks are unavailable' }
    if (!r.ok) return { text: `Centralu update did not start: ${r.error ?? 'unavailable'}`, isError: true }
    const s = r.status
    if (!s) return { text: 'Centralu update is unavailable.', isError: true }
    if (action === 'check') return { text: s.newer && s.latest ? `Centralu ${s.latest} is available.` : s.error ?? 'Centralu is up to date.' }
    return { text: s.phase === 'failed' ? `Centralu update failed: ${s.error}` : `Installing Centralu ${s.latest ?? ''}. The person applies the installed build from Centralu; their automatic-update setting was not changed.` }
  }
  if (name === 'list_sessions') return listSessionsText(tools, caller)

  if (name === 'centralu_commands' || name === 'centralu_help' || name === 'centralu_run') return runCommandTool(tools, name, args, caller, signal)

  if (name === 'ask_project') {
    // Only the reader seat has it (profileAllows) — checked here too, since this runner is shared by every seat
    if (caller.profile !== 'reader') return { text: `Not a tool of this session: ${name}`, isError: true }
    const project = typeof args.project === 'string' ? args.project.trim() : ''
    if (!project) return { text: 'Give a project — the name of another Centralu project.', isError: true }
    const task = typeof args.task === 'string' && args.task.trim() ? args.task : undefined
    return askProjectText(await tools.askProject({ project, ...(task ? { task } : {}) }, signal))
  }

  if (name === 'start_agent' || name === 'agent_session') {
    // A reader's alone (profileAllows), checked here too since this runner is shared by every seat
    if (caller.profile !== 'reader') return { text: `Not a tool of this session: ${name}`, isError: true }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    if (name === 'start_agent') {
      const task = typeof args.task === 'string' && args.task.trim() ? args.task : undefined
      if (!task) return { text: 'Give a task: what the new session should do.', isError: true }
      const tool = str(args.tool)
      const model = str(args.model)
      const effort = str(args.effort)
      const branch = str(args.branch)
      return agentRunText(
        await tools.startAgent(
          {
            task,
            ...(tool ? { tool } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(args.wait === false ? { wait: false } : {}),
            ...(args.worktree === true || branch ? { worktree: true } : {}),
            ...(branch ? { branch } : {}),
          },
          signal,
        ),
      )
    }
    const sessionId = str(args.sessionId)
    const action = args.action
    if (!sessionId) return { text: 'Give the sessionId start_agent returned.', isError: true }
    if (action !== 'status' && action !== 'send' && action !== 'wait' && action !== 'stop' && action !== 'delete') {
      return { text: 'Give an action: status, send, wait, stop or delete.', isError: true }
    }
    const text = typeof args.text === 'string' && args.text.trim() ? args.text : undefined
    if (action === 'send' && !text) return { text: 'Give text: what to send it.', isError: true }
    return agentRunText(await tools.agentSession({ sessionId, action, ...(text ? { text } : {}) }, signal))
  }

  if (name === 'recall') {
    const query = String(args.query ?? '')
    const r = await tools.recall(query, args.limit as number | undefined)
    // A machine that is off says it could not be searched, rather than finding nothing (#82, decided 2026-10-03)
    const unsearched = r.notSearched?.length ? `\nNot searched: ${r.notSearched.join('; ')}.` : ''
    if (r.hits.length === 0) return { text: `Nothing was found for "${query}". Try a different word.${unsearched}` }
    /*
     * The seq is included with each hit — this is the link that meshes recall with read_session.
     * Without it, the model finds something but has nowhere to go, and has to pull up the whole
     * session and search it by eye.
     */
    return {
      text: r.hits
        .map(
          (h) =>
            `- [${h.project}${h.machine ? ` on ${h.machine}` : ''}] ${h.session}${h.at ? ` · ${h.at}` : ''}\n` +
            `    snippet(JSON): ${trustedJsonText(h.snippet)}\n` +
            `    → read_session(sessionId="${h.sessionId}", around=${h.seq})`,
        )
        .join('\n') + unsearched,
    }
  }

  if (name === 'read_session') {
    // The reader set has no list_sessions — listing is read_session without an id (#320, see READER_TOOLS)
    if (caller.profile === 'reader' && !args.sessionId) return listSessionsText(tools, caller)
    const r = await tools.readSession(String(args.sessionId ?? ''), args.limit as number | undefined, {
      around: typeof args.around === 'number' ? args.around : undefined,
      tools: args.tools === true,
    })
    if (!r.ok) return { text: `Could not read it — ${r.error}`, isError: true }
    /*
     * If it is still answering, say so.
     * Measured: once read_session existed, the model started choosing it over reportBack, and
     * because it read right after sending, it received a "result" that was only the person's
     * instruction with no answer yet.
     * Instead of a persuasive line, give the plain fact of the current state — the judgment is
     * left to whoever reads it.
     */
    const head =
      r.state === 'working'
        ? '⏳ This session is still answering. Below is the conversation so far, and the final answer may be missing.\n' +
          // A reader (#320) has no send_to_session — pointing it at reportBack would name a tool it cannot call
          (caller.profile === 'reader' ? '\n' : '   If you want to know once it is done, use send_to_session\'s reportBack.\n\n')
        : ''
    return { text: head + (r.lines?.join('\n') || '(no conversation)') }
  }

  if (name === 'create_project') {
    /*
     * The card is the permission (#515): the manager raises it and makes nothing until the person approves, so an
     * instruction carried in through read_session or recall reaches, at most, a card the person reads with the full
     * path on it. The names come back JSON-quoted: the folder's name is whatever the model was given.
     */
    const folder = typeof args.name === 'string' ? args.name : ''
    const git = typeof args.git === 'string' && args.git.trim() ? args.git.trim() : undefined
    if (!folder.trim() && !git) return { text: 'Give a name — the new folder is named by it, and so is the project.', isError: true }
    const parent = typeof args.parent === 'string' && args.parent.trim() ? args.parent.trim() : undefined
    const branch = git && typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
    const source = git ? { git, ...(branch ? { branch } : {}) } : undefined
    const machine = typeof args.machine === 'string' && args.machine.trim() ? args.machine.trim() : undefined
    const r = await tools.createProject({ name: folder, ...(parent ? { parent } : {}), ...(source ? { source } : {}), ...(machine ? { machine } : {}) }, signal)
    if (!r.ok) return { text: `No project was made: ${r.error}`, isError: true }
    return {
      text:
        `Made the project ${trustedJsonText(r.name)} [${r.projectId}], ${git ? `a clone of ${trustedJsonText(git)}` : 'an empty folder'} at ${trustedJsonText(r.path)}` +
        `${r.machine ? ` on ${r.machine}` : ''}. ` +
        'Start work in it with create_session (project = that id).',
    }
  }

  if (name === 'propose_skill') {
    const spec = {
      name: String(args.name ?? '').trim(),
      content: String(args.content ?? ''),
      why: typeof args.why === 'string' ? args.why : undefined,
    }
    if (!spec.name || !spec.content.trim()) {
      return { text: 'Give name and content — a procedure with no name cannot be found, and a procedure with no content is not a procedure.', isError: true }
    }
    const r = await tools.proposeSkill(spec)
    if (!r.ok) return { text: `Could not propose it — ${r.error}`, isError: true }
    return {
      text:
        `Proposed the "${spec.name}" skill. An approval card appeared on screen, and once the person approves it, it is saved and ` +
        'this session restarts — after the restart, the conversation continues and the skill is carried in the role. It has no effect at all until approved.',
    }
  }

  if (name === 'propose_mcp_server') {
    const spec = {
      name: String(args.name ?? '').trim(),
      command: String(args.command ?? '').trim(),
      args: Array.isArray(args.args) ? args.args.map(String) : [],
      why: typeof args.why === 'string' ? args.why : undefined,
    }
    if (!spec.name || !spec.command) {
      return { text: 'Give name and command — a proposal cannot be made without knowing what to start and how.', isError: true }
    }
    const r = await tools.proposeMcpServer(spec)
    if (!r.ok) return { text: `Could not propose it — ${r.error}`, isError: true }
    return {
      text:
        `Proposed the "${spec.name}" MCP server. An approval card appeared on screen, and once the person approves it, ` +
        `that server becomes a user-folder app and this session restarts — after the restart, the conversation continues and the new tools appear under the app-${spec.name} server. ` +
        'It is not installed until approved.',
    }
  }

  if (name === 'check') {
    // The result is a report for the agent to read. Even if there is a problem, the tool call
    // itself succeeds — the verdict is carried in the text.
    const r = await tools.checkApp()
    return { text: r.text }
  }

  if (name === 'create_app') {
    const spec = {
      id: String(args.id ?? '').trim(),
      name: String(args.name ?? '').trim(),
      project: typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      tool: ToolName.safeParse(args.tool).data,
    }
    if (!spec.id || !spec.name) return { text: 'Give id and name — a folder name and a name to show the person are needed for the app to stand.', isError: true }
    const r = await tools.createApp(spec)
    if (!r.ok) return { text: `Could not create it — ${r.error}`, isError: true }
    const where = r.projectId === null ? 'user folder' : 'project'
    /*
     * What comes next belongs to the building session — the orchestrator does not write app code
     * (it has no hands). It tells the model to hand off what to build to that session. If the
     * session failed to start, the reason is carried through as-is.
     */
    const next = r.builder
      ? `Building session: ${r.builder.name} [${r.builder.sessionId}] — send_to_session it what to build (the person's request, exactly as given).`
      : `The building session did not start: ${r.builderError ?? 'no reason was given'} — let the person know.`
    return {
      text:
        `Created the "${spec.name}" app (${where}, id ${r.appId}): ${r.dir}\n` +
        `It is the app exactly as the template gives it (a counter). In a session it attaches as the app-${r.appId} server. The app comes up the first time it is needed.\n` +
        next,
    }
  }

  if (name === 'find_apps' || name === 'attach_app' || name === 'detach_app') return runAppAccess(tools, name, args)

  if (name === 'app_guide') {
    // Does not go through the manager — text baked into the build plus the tool registry is the whole guide (#30, M4 P-4)
    return appGuide(typeof args.topic === 'string' ? args.topic : undefined, guideSeats())
  }

  if (name === 'update_session_settings') {
    const r = await tools.updateSessionSettings(String(args.sessionId ?? ''), {
      ...(args.model !== undefined ? { model: args.model as string | null } : {}),
      ...(args.effort !== undefined ? { effort: args.effort as string | null } : {}),
      ...(args.verbosity !== undefined ? { verbosity: args.verbosity as string | null } : {}),
    })
    return {
      text: r.ok
        ? r.deferred
          ? `Changed: ${args.sessionId} — applies once the turn now running ends. Also notified the screen` // does not cut off the running turn (#164)
          : `Changed: ${args.sessionId} — also notified the screen` // no change without a trace (#30)
        : `Could not change it — ${r.error}`,
      isError: !r.ok,
    }
  }

  if (name === 'create_session') {
    const r = await tools.createSession({
      project: typeof args.project === 'string' ? args.project : undefined,
      tool: ToolName.safeParse(args.tool).data,
      name: typeof args.name === 'string' ? args.name : undefined,
      firstMessage: typeof args.firstMessage === 'string' ? args.firstMessage : undefined,
    })
    return {
      text: r.ok
        ? `Created: ${r.name} [${r.sessionId}]` + (typeof args.firstMessage === 'string' ? ' — sent the first instruction' : '')
        : `Could not create it — ${r.error}`,
      isError: !r.ok,
    }
  }

  if (name === 'send_to_session') {
    const sessionId = String(args.sessionId ?? '')
    const reportBack = args.reportBack === true
    const r = await tools.sendToSession(sessionId, String(args.text ?? ''), reportBack)
    /*
     * Report the failure as-is. If it silently pretended to succeed, the orchestrator would
     * believe it had assigned the work and move on, and the person would only see "I asked for
     * it, and it did not happen."
     */
    return {
      text: r.ok
        ? `Sent: ${sessionId}${reportBack ? ' (I will let you know once it is done)' : ''}`
        : `Could not send it — ${r.error}`,
      isError: !r.ok,
    }
  }

  return { text: `Unknown tool: ${name}`, isError: true }
}

/**
 * The app-access tools' texts (#371 part A). Each result names what to do next, because the tools
 * are deferred: the model that found find_apps learns attach_app from its answer, and detach_app from
 * attach_app's. Names an app or a project chose are JSON-quoted, like a worker's text (#121): a
 * description is the app author's words, not ours.
 */
async function runAppAccess(tools: OrchestratorTools, name: AppAccessToolName, args: Record<string, unknown>): Promise<ToolOutput> {
  if (name === 'find_apps') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const r = await tools.findApps(query || undefined)
    if (!r.ok) return { text: r.error, isError: true }
    if (r.apps.length === 0) {
      return {
        text: query
          ? `No app matches ${trustedJsonText(query)}. Try find_apps with no query to see every app you can attach.`
          : "No app can be attached: no other project shares one and there is no app in the person's own folder. Sharing is the person's choice, per app (Settings → Apps).",
      }
    }
    return {
      text:
        r.apps
          .map(
            (a) =>
              `- ${a.ref} · ${a.project === null ? "the person's own app" : `project ${trustedJsonText(a.project)}`}` +
              `\n    ${trustedJsonText(a.name)}${a.description ? `: ${trustedJsonText(a.description)}` : ''}` +
              `\n    tools: ${a.tools ? a.tools.join(', ') || '(none)' : '(listed once attached)'}`,
          )
          .join('\n') + '\nAttach one with attach_app(app="<the name before ·>").',
    }
  }
  const app = String(args.app ?? '').trim()
  if (!app) return { text: 'Give app — a name find_apps gave.', isError: true }
  if (name === 'attach_app') {
    const r = await tools.attachApp(app)
    if (!r.ok) return { text: `Not attached: ${r.error}`, isError: true }
    const names = r.tools.length ? r.tools.map((t) => `mcp__${r.server}__${t}`).join(', ') : '(it listed none yet)'
    const when =
      r.when === 'now'
        ? 'Its tools are available now.'
        : "This agent keeps the tools its thread started with, so the session restarts its thread when this turn ends and the tools are there from the next turn. Finish this turn and tell the person the app is attached."
    return {
      text:
        `${r.already ? 'Already attached' : 'Attached'}: ${app} as the ${r.server} server. Tools: ${names}. ${when}\n` +
        `When you no longer need it, call detach_app(app=${trustedJsonText(app)}) so its tools stop taking up context.`,
    }
  }
  const r = await tools.detachApp(app)
  if (!r.ok) return { text: `Not detached: ${r.error}`, isError: true }
  return {
    text:
      r.when === 'now'
        ? `Detached ${app}: the ${r.server} tools are gone.`
        : `Detached ${app}: calls to the ${r.server} tools are refused from now on, and the names leave when this turn ends (the thread restarts).`,
  }
}

/** A command's one line in centralu_commands: its description's first sentence, without emphasis or issue numbers */
function commandLine(description: string): string {
  const plain = description.replace(/\*\*/g, '').replace(/ \((?:#\d+|M4)\)/g, '')
  const end = plain.indexOf('. ')
  return end >= 0 ? plain.slice(0, end + 1) : plain
}

function commandDef(name: string) {
  return ORCHESTRATOR_TOOLS.find((t) => t.name === name)
}

function commandSchemaText(name: string): string {
  const def = commandDef(name)
  return def ? JSON.stringify(z.toJSONSchema(def.schema.strict())) : '{}'
}

/**
 * The `commands` tier's three tools (#512). The gate is the seat's: `commandsFor` lists and runs only the
 * commands its profile allows, so a command outside it is neither listed nor run, the same answer as calling
 * a tool the seat was not given. A run is checked against the command's own schema here, strictly (a key the
 * command does not take is wrong, not ignored: `arguments` for propose_mcp_server's `args` would otherwise
 * propose a server with none), and a wrong call answers with that schema so the next try can be right. A
 * valid run is the command itself, through the same runner, so its result, its card and its gates are the
 * ones it has as a tool.
 */
async function runCommandTool(
  tools: OrchestratorTools,
  name: CommandToolName,
  args: Record<string, unknown>,
  caller: ToolCaller,
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const commands = commandsFor(caller.profile)
  if (!commands.length) return { text: `Not a tool of this session: ${name}`, isError: true }
  const known = `Commands: ${commands.join(', ')}.`
  const command = typeof args.command === 'string' ? args.command.trim() : ''

  if (name === 'centralu_commands') {
    const words = (typeof args.query === 'string' ? args.query.toLowerCase().match(/[a-z0-9]{3,}/g) : null) ?? []
    const line = (c: string) => `- ${c}: ${commandLine(commandDef(c)?.description ?? '')}`
    const hits = words.length ? commands.filter((c) => words.some((w) => `${c.replace(/_/g, ' ')} ${line(c)}`.toLowerCase().includes(w))) : commands
    const head = words.length && !hits.length ? `No command matches ${trustedJsonText(String(args.query))}; every command:\n` : ''
    return {
      text: `${head}${(hits.length ? hits : commands).map(line).join('\n')}\nRead one's arguments with centralu_help(command), run it with centralu_run(command, args).`,
    }
  }

  if (!(commands as string[]).includes(command)) {
    if (name === 'centralu_run') logRun(caller, command, 'no such command')
    return { text: `No command ${trustedJsonText(command)} for this session. ${known}`, isError: true }
  }
  const def = commandDef(command)!

  if (name === 'centralu_help') {
    return {
      text: `${command}: ${def.description}\nArguments (JSON schema): ${commandSchemaText(command)}\nRun it with centralu_run(command="${command}", args={…}).`,
    }
  }

  // Codex's exec may hand the arguments over as JSON text rather than an object
  let raw: unknown = args.args ?? {}
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      /* answered below, with the schema */
    }
  }
  const parsed = def.schema.strict().safeParse(raw)
  if (!parsed.success) {
    logRun(caller, command, 'wrong arguments')
    return {
      text:
        `Wrong arguments for ${command}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ')}.\n` +
        `Its arguments (JSON schema): ${commandSchemaText(command)}\nCall centralu_run again with args that match.`,
      isError: true,
    }
  }
  logRun(caller, command, 'ran')
  return runOrchestratorTool(tools, command, parsed.data as Record<string, unknown>, caller, signal)
}

/**
 * One line per centralu_run on stderr (the host's log): which command a seat ran and whether it got past the
 * schema. Codex calls MCP tools from inside its `exec` and the host's event for such a call carries no
 * arguments, so this is where a run of a command can be told from a wrong one (the measurement reads it).
 * The command's name only: arguments are the model's words.
 */
function logRun(caller: ToolCaller, command: string, outcome: 'ran' | 'wrong arguments' | 'no such command'): void {
  console.error(`[commands] ${caller.sessionId ?? '-'} centralu_run ${JSON.stringify(command.slice(0, 64))}: ${outcome}`)
}

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
 * How a seat's rarely used commands reach the model (#512, chosen by `CC_RARE_COMMANDS`; the comparison of the
 * three is in docs/tool-cost.md §9). `commands` is the default since the owner's decision of 2026-10-12 (no loss
 * on Sonnet, 835 tokens fewer per orchestrator request, and a tool list that does not grow with the commands);
 * the other two stay selectable for measurement.
 *
 *   - `resident`: every tool in every request, as before #512.
 *   - `deferred`: the rare ones wait behind Claude's tool search, the way the reader's app_guide does.
 *     Codex reaches every MCP tool through its own `exec` anyway (tool-cost.md §6.2), so this is Claude's alone.
 *   - `commands`: the rare ones leave the tool list. Three fixed tools stand in for them (COMMAND_TOOLS):
 *     list, describe, run. The host checks a run against the command's own schema and the seat's
 *     profile, the same gates the command has as a tool.
 *
 * One host-wide setting, read once at start (main.ts), because the tool list a session starts with is
 * its prompt prefix: a session that changed tier mid-run would rebuild its cache.
 */
export const RARE_TIERS = ['resident', 'deferred', 'commands'] as const
export type RareTier = (typeof RARE_TIERS)[number]

/** The tier a host runs with when `CC_RARE_COMMANDS` names none (#512, decision of 2026-10-12) */
export const DEFAULT_RARE_TIER: RareTier = 'commands'

let rareTier: RareTier = DEFAULT_RARE_TIER

/** The tier from `CC_RARE_COMMANDS`: anything else is the default */
export function rareTierFrom(value: string | undefined): RareTier {
  return (RARE_TIERS as readonly string[]).includes(value ?? '') ? (value as RareTier) : DEFAULT_RARE_TIER
}

export function setRareTier(tier: RareTier): void {
  rareTier = tier
}

export function currentRareTier(): RareTier {
  return rareTier
}

/**
 * Which commands are rare, per seat. The orchestrator's alone: the other directing seats carry a few tools
 * each, all of them their reason to exist.
 *
 * In: create_app, propose_skill and propose_mcp_server (1,462, 1,144 and 1,098 characters, a third of the
 * orchestrator's every request, asked for a few times in a seat's life). The instructions name each of them
 * and say when, which is what a model that cannot see them goes looking with.
 * Out: propose_worktree_session, before it went with the worktree manager (#561 part 3): asked for a branch, the
 * orchestrator reached it 3 of 3 times as a tool and 0 of 3 deferred or behind centralu_run (tool-cost.md §9).
 * Out: app_guide. It answers the person's own questions about the app, which come often and
 * without warning; deferred, a reader found it 4 of 5 times and never for a question about a setting (§8). Out
 * too: everything the instructions tell the orchestrator to reach for first (list, read, recall, send, create
 * a session or a project).
 */
export const RARE_COMMANDS: Partial<Record<ToolProfile, readonly OrchestratorToolName[]>> = {
  orchestrator: ['create_app', 'propose_skill', 'propose_mcp_server', 'update_centralu'],
}

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

/** The fixed line the `commands` tier adds to the seat's instructions (#512): the tools alone were not a promise the model would look */
export const COMMANDS_INSTRUCTION =
  'Some commands, among them those named above, are not in your tool list: centralu_commands lists them, centralu_help gives one\'s arguments, centralu_run runs it.'

/** The commands this seat reaches through centralu_run in this tier: never one its profile does not allow */
export function commandsFor(profile: ToolProfile | 'human', tier: RareTier = rareTier): OrchestratorToolName[] {
  if (tier !== 'commands' || profile === 'human') return []
  return (RARE_COMMANDS[profile] ?? []).filter((n) => baseAllows(profile, n))
}

/** The tools this seat's Claude server defers behind tool search in this tier (the reader set marks its own) */
function deferredFor(profile: ToolProfile, tier: RareTier): readonly string[] {
  return tier === 'deferred' ? (RARE_COMMANDS[profile] ?? []) : []
}

/**
 * Whether this profile allows the tool — both exposure (schemas) and execution (run) are decided by this.
 *
 * In the `commands` tier a rare command is not a tool of the seat: it is refused by name, as any tool the
 * seat was not shown, and runs only through centralu_run, which `commandsFor` gates with the same rule.
 */
export function profileAllows(profile: ToolProfile, name: string, tier: RareTier = rareTier): boolean {
  if (COMMAND_TOOLS.some((t) => t.name === name)) return commandsFor(profile, tier).length > 0
  if ((commandsFor(profile, tier) as string[]).includes(name)) return false
  return baseAllows(profile, name)
}

/** The profile rule itself, whatever the tier: who may use which of Centralu's commands */
function baseAllows(profile: ToolProfile, name: string): boolean {
  if (profile === 'reader') {
    return (
      name === 'update_centralu' ||
      READER_TOOLS.some((t) => t.name === name) ||
      DELEGATE_TOOLS.some((t) => t.name === name) ||
      AGENT_TOOLS.some((t) => t.name === name) ||
      APP_ACCESS_TOOLS.some((t) => t.name === name)
    )
  }
  // ask_project, start_agent and the app-access tools (#371, #561) are a reader's alone: every directing seat already
  // works inside its own view
  if (DELEGATE_TOOLS.some((t) => t.name === name) || AGENT_TOOLS.some((t) => t.name === name) || APP_ACCESS_TOOLS.some((t) => t.name === name)) return false
  if (profile === 'orchestrator') return !(BUILDER_TOOL_NAMES as readonly string[]).includes(name)
  if (profile === 'scoped') return (SCOPED_TOOL_NAMES as readonly string[]).includes(name)
  return (BUILDER_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * The built-in tool definitions this profile is given — the one list the in-process MCP, the
 * bridge's schemas and the guide all read. The reader set (#320) has its own words; every other
 * profile is a filter over the orchestrator's.
 */
export function toolDefsFor(
  profile: ToolProfile,
  tier: RareTier = rareTier,
): readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[] {
  if (profile === 'reader') return [...READER_TOOLS, ...DELEGATE_TOOLS, ...AGENT_TOOLS, ...APP_ACCESS_TOOLS]
  const deferred = deferredFor(profile, tier)
  return [
    ...ORCHESTRATOR_TOOLS.filter((t) => profileAllows(profile, t.name, tier)).map((t) => (deferred.includes(t.name) ? { ...t, deferred: true } : t)),
    ...(commandsFor(profile, tier).length ? COMMAND_TOOLS : []),
  ]
}

/**
 * The server instructions for a profile, or undefined for none. In one place so the size test
 * measures the exact text the adapter sends.
 */
export function instructionsFor(profile: ToolProfile, tier: RareTier = rareTier): string | undefined {
  switch (profile) {
    case 'scoped': return SCOPED_INSTRUCTIONS
    case 'builder': return BUILDER_INSTRUCTIONS
    case 'reader': return readerInstructions ? READER_INSTRUCTIONS : undefined
    default: return commandsFor(profile, tier).length ? `${ORCHESTRATOR_INSTRUCTIONS}\n${COMMANDS_INSTRUCTION}` : ORCHESTRATOR_INSTRUCTIONS
  }
}

/**
 * The same instructions as a Codex thread's developer instructions carry them (#525).
 *
 * Claude Code shows a server's `instructions` to the model; codex-cli 0.160.0 does not. Measured
 * (`scripts/probe-codex-mcp-instructions.mts`, 2026-10-12): a stdio server whose `initialize` answered with
 * `instructions` started, its tool was listed and reached, yet the model could not name a phrase from them, and the
 * thread's rollout had no trace of them, in four runs; the phrase in `developerInstructions` was named every time,
 * and the rollout holds it as a developer message. So the bridge sends none, and the adapter appends this to the
 * thread's developer instructions. The header says whose they are: Codex shows these tools to the model as
 * `mcp__centralu__<tool>`, and the text names them bare, as Claude Code's section heading (the server's name) does.
 */
export function codexToolInstructionsFor(profile: ToolProfile, tier: RareTier = rareTier): string | undefined {
  const text = instructionsFor(profile, tier)
  return text ? `# How to use the ${ORCHESTRATOR_MCP_NAME} tools (mcp__${ORCHESTRATOR_MCP_NAME}__*)\n\n${text}` : undefined
}

/** The adapter decides the channel; this module only owns the shared wording. */
export function toolInstructionsFor(
  profile: ToolProfile,
  channel: 'server' | 'developer',
  tier: RareTier = rareTier,
): string | undefined {
  return channel === 'developer' ? codexToolInstructionsFor(profile, tier) : instructionsFor(profile, tier)
}

/**
 * The tools this profile can call **right now** — the same decision as the exposure logic
 * (orchestratorToolSchemas). The guide uses this when it states what each seat can do (M4 P-4):
 * writing the list out by hand would let the guide fall behind every time a tool is added or
 * removed. Read in the `resident` tier: the guide says what a seat can do, not how its tools are packed (#512).
 */
function toolsFor(profile: ToolProfile): GuideTool[] {
  return toolDefsFor(profile, 'resident').map((t) => ({ name: t.name, description: t.description }))
}

function guideSeats(): GuideSeats {
  return { orchestrator: toolsFor('orchestrator'), scoped: toolsFor('scoped'), reader: toolsFor('reader') }
}

export function orchestratorToolSchemas(
  profile: ToolProfile = 'orchestrator',
): { name: string; description: string; inputSchema: unknown }[] {
  return toolDefsFor(profile).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema),
  }))
}
