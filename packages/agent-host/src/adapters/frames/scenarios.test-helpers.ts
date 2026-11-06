import { alwaysAllowKey, type NormalizedEvent, type PermissionPreset } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, SessionHandle } from '../contract.js'
import { fakeApps, fakeCentraluTools } from './fakes.test-helpers.js'

/**
 * The scenarios a recording is made of, at the level of the adapter contract (`SessionHandle`), so any adapter (ACP or a
 * stream-json CLI's) can be recorded and replayed with them (docs/plans/acp-adapter.md §10.4). The same code drives the adapter against
 * the real CLI (`scripts/frames-record.mts`, which writes the recording) and against the recording (`replay.test.ts`), so a
 * replay sends exactly what the recorded run sent. Prompts are short: a recording spends the person's model calls.
 */

export type Driver = {
  readonly events: NormalizedEvent[]
  /** The tool being driven */
  readonly tool: string
  /** The session's working folder */
  readonly cwd: string
  /** Files the real tool is to find in its working folder; a replay has nothing to write them with */
  seed(files: Record<string, string | Buffer>): void
  session(): SessionHandle
  /** The next event after the ones already waited for that `pick` accepts: resolved when it is emitted, never polled */
  waitFor(label: string, pick: (e: NormalizedEvent) => boolean): Promise<NormalizedEvent>
  /** Ends this process and opens the conversation again in a new one, as a host restart does */
  reopen(): Promise<void>
  /** Kills the agent process, as a crash would */
  kill(): void
}

/** The tools whose recordings come from the scenarios that name no tool of their own */
const ACP_TOOLS: readonly string[] = ['cursor-agent', 'opencode']
const ANY_TOOL: readonly string[] = [...ACP_TOOLS, 'claude', 'codex']
/** The tools that are not ACP: the same scenarios, but each is recorded with its own presets and prompts */
const CLI_TOOLS: readonly string[] = ['claude', 'codex']

export type Scenario = {
  name: string
  /** The tools this scenario is recorded for; the ACP ones when absent */
  tools?: readonly string[]
  /** The preset a tool is recorded under when it is not the scenario's own */
  presetFor?: Partial<Record<string, PermissionPreset>>
  /** A model the scenario asks for in place of the run's (a failed turn names one that does not exist) */
  model?: string
  preset?: PermissionPreset
  /**
   * The tool's own settings for the run (Codex: its settings folder holds them): `mcp` sets it up with a small MCP server,
   * `probe`, whose one tool `ping` answers `pong`
   */
  settings?: 'mcp'
  /** Whether the tool must be made to ask for every command (OpenCode: through its config; a profile knows how) */
  asksForCommands?: boolean
  /** What the scenario adds to the session it opens: Centralu's tools or an app, answered by `fakes.test-helpers.ts` */
  session?: () => Partial<CreateSessionOpts>
  run(d: Driver): Promise<void>
}

const ended = (e: NormalizedEvent) => e.type === 'turn_complete' || e.type === 'error' || (e.type === 'state_change' && e.state === 'waiting_input')
const turn = async (d: Driver, text: string, opts?: { compact?: boolean }) => {
  d.session().send(text, opts)
  return d.waitFor(`the end of the turn "${text.slice(0, 30)}"`, ended)
}
/** A command the tool asks about: Claude Code and Codex run a read-only one such as echo without asking, so they are given one that writes */
const commandAsked = (d: Driver, n: number | string) => (CLI_TOOLS.includes(d.tool) ? `touch probe-${n}.txt` : `echo probe-${n}`)
/** A turn in which every card asked is answered `decide` until the turn ends; the kinds of card asked, in order */
const answeredTurn = async (d: Driver, text: string, decide: 'allow' | 'deny'): Promise<string[]> => {
  d.session().send(text)
  const asked: string[] = []
  for (;;) {
    const e = await d.waitFor(`a card or the end of the turn "${text.slice(0, 30)}"`, (x) => x.type === 'approval_request' || ended(x))
    if (e.type !== 'approval_request') return asked
    asked.push(e.detail.kind)
    d.session().respondApproval(e.requestId, decide)
  }
}

/** A 2x2 red PNG: an image for a tool to read */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==', 'base64')

export const SCENARIOS: readonly Scenario[] = [
  {
    // Read and Edit inside the folder, then a command: `edits` grants the edit, so the command is asked about once
    name: 'tools',
    tools: ['claude'],
    preset: 'edits',
    async run(d) {
      d.seed({ 'note.txt': 'The sky is red.\n' })
      const asked = await answeredTurn(d, 'Use the Read tool on note.txt, then the Edit tool to change the word red to blue in it, then run the shell command: touch tools-done.txt . Then say done.', 'allow')
      if (asked.length === 0) throw new Error('tools: the command was not asked about')
    },
  },
  {
    name: 'background',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      d.session().send('Start this in the background with the Bash tool (run_in_background): sleep 4 && echo bg-done . Then say started and end your turn.')
      await d.waitFor('the background task', (e) => e.type === 'background_tasks' && e.live.length > 0)
      await d.waitFor('the end of the first turn', ended)
      // The task ends on its own, and the CLI wakes the model with its result
      await d.waitFor('the task ended', (e) => e.type === 'background_tasks' && (e.ended?.length ?? 0) > 0)
      await d.waitFor('the end of the turn that reports it', ended)
    },
  },
  {
    // A model the API does not have: the turn fails at once
    name: 'failed',
    tools: CLI_TOOLS,
    model: 'no-such-model-xyz',
    async run(d) {
      d.session().send('Reply with exactly: hello')
      await d.waitFor('the failure', (e) => e.type === 'error')
    },
  },
  {
    name: 'interrupt-tool',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      // Not `sleep 120`: Claude Code refuses a long sleep before it runs (measured), and nothing would be interrupted
      d.session().send('Run this shell command and wait for it: node -e "setTimeout(() => {}, 120000)"')
      await d.waitFor('the command call', (e) => e.type === 'tool_call' && (e.summary.tool === 'Bash' || e.summary.tool === 'PowerShell'))
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
      await turn(d, 'Say ok.')
    },
  },
  {
    name: 'big-output',
    tools: CLI_TOOLS,
    async run(d) {
      await turn(d, 'Count from 1 to 150, one number per line, and nothing else.')
    },
  },
  {
    // A subagent with a tool of its own, and its result
    name: 'subagent',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      d.seed({ 'note.txt': 'The sky is red.\n' })
      await turn(d, 'Use the Agent tool to start a subagent. Run it in the foreground (not in the background) and wait for its result. The subagent is to use the Read tool on note.txt and report its text. Then tell me in one sentence what it reported.')
    },
  },
  {
    // AskUserQuestion answered with its first option
    name: 'question',
    tools: ['claude'],
    async run(d) {
      d.session().send('Use the AskUserQuestion tool to ask me which colour to use, with exactly two options: red and blue. Then tell me which one I chose.')
      const card = await d.waitFor('a question card', (e) => e.type === 'question_request')
      if (card.type !== 'question_request') return
      const q = card.questions[0]!
      d.session().answerQuestion!(card.requestId, [{ question: q.question, answers: [q.options[0]!.label] }])
      await d.waitFor('the end of the turn', ended)
    },
  },
  {
    // The question card closed with a Stop instead of an answer
    name: 'question-declined',
    tools: ['claude'],
    async run(d) {
      d.session().send('Use the AskUserQuestion tool to ask me which colour to use, with exactly two options: red and blue.')
      await d.waitFor('a question card', (e) => e.type === 'question_request')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
    },
  },
  {
    // Plan mode: a plan proposed, then approved
    name: 'plan',
    tools: ['claude'],
    async run(d) {
      d.session().send('Use the EnterPlanMode tool, then plan how you would add a file named plan-done.txt containing the word ok, and present the plan with the ExitPlanMode tool. Do not write the file.')
      for (;;) {
        const e = await d.waitFor('a card or the end of the turn', (x) => x.type === 'approval_request' || x.type === 'question_request' || ended(x))
        if (e.type === 'approval_request') d.session().respondApproval(e.requestId, 'allow')
        else if (e.type === 'question_request') d.session().answerQuestion!(e.requestId, [{ question: e.questions[0]!.question, answers: [e.questions[0]!.options[0]!.label] }])
        else return
      }
    },
  },
  {
    // A task started in the background, polled for its output, finished
    name: 'background-poll',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      d.session().send('Start this in the background with the Bash tool (run_in_background): sleep 3 && echo poll-done . Then run `sleep 6` in the foreground, then read the output file that the background start reported with the Read tool, and tell me what it holds.')
      await d.waitFor('the task ended', (e) => e.type === 'background_tasks' && (e.ended?.length ?? 0) > 0)
      await d.waitFor('the end of the turn', ended)
    },
  },
  {
    // A task still running when the turn ends, and the session closed with it running
    name: 'background-open',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      d.session().send('Start this in the background with the Bash tool (run_in_background): sleep 90 . Then say started and end your turn.')
      await d.waitFor('the background task', (e) => e.type === 'background_tasks' && e.live.length > 0)
      await d.waitFor('the end of the turn', ended)
    },
  },
  {
    name: 'centralu-mail',
    tools: ['claude'],
    session: () => ({ orchestratorTools: fakeCentraluTools(), toolProfile: 'reader' }),
    async run(d) {
      await turn(d, 'Use the mail tool of the centralu server to read your inbox, then send a message to "Docs worker" saying: use LICENSE. Then say done.')
    },
  },
  {
    name: 'centralu-agents',
    tools: ['claude'],
    session: () => ({ orchestratorTools: fakeCentraluTools(), toolProfile: 'reader' }),
    async run(d) {
      await turn(d, 'Use the recall tool of the centralu server to search for "naming". Then use its read_session tool on the session it found. Then use its start_agent tool with the task "list the notes". Then summarise all three in two sentences.')
    },
  },
  {
    name: 'centralu-compact',
    tools: ['claude'],
    session: () => ({ orchestratorTools: fakeCentraluTools(), toolProfile: 'reader' }),
    async run(d) {
      await turn(d, 'Call the compact_self tool of the centralu server with the focus "the naming decision", and tell me what it answered.')
    },
  },
  {
    // A tool of an attached app (another MCP server)
    name: 'mcp-app',
    tools: ['claude'],
    session: () => ({ apps: fakeApps() }),
    async run(d) {
      await turn(d, 'Use the forecast tool of the weather app for the city Paris, and tell me what it says.')
    },
  },
  {
    // A command that exits with a non-zero code, and a Read of a file that is not there
    name: 'tool-error',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Run this shell command and tell me its exit code: node -e "console.error(\'boom\'); process.exit(3)" . Then use the Read tool on missing-file.txt and tell me what happened.')
    },
  },
  {
    // A command whose output is far past what the CLI hands the model
    name: 'long-output',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Run this shell command and say only how many lines you saw at the end: node -e "for (let i = 1; i <= 6000; i++) console.log(\'line \' + i)"')
    },
  },
  {
    name: 'markdown',
    tools: ['claude'],
    async run(d) {
      await turn(d, 'Without using any tool, answer in Markdown: a heading, a short bulleted list of three items, a TypeScript code block of a two-line function, and a table of three rows with columns Name and Value.')
    },
  },
  {
    // An image the agent reads
    name: 'image',
    tools: ['claude'],
    preset: 'edits',
    async run(d) {
      d.seed({ 'picture.png': PNG })
      await turn(d, 'Use the Read tool on picture.png and tell me, in one word, its colour.')
    },
  },
  {
    // A turn on the PowerShell tool, which Claude Code offers on Windows
    name: 'powershell',
    tools: ['claude'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Use the PowerShell tool to run: Write-Output "ps-ok". Then say done.')
    },
  },
  {
    name: 'basic',
    tools: ANY_TOOL,
    // Claude Code asks before it writes a file unless the preset grants edits in the folder, and OpenCode before every write under Normal;
    // this scenario answers no card (it would wait for ever)
    presetFor: { claude: 'edits', opencode: 'auto', codex: 'auto' },
    async run(d) {
      await turn(d, 'Reply with exactly: hello')
      await turn(d, 'Create a file named probe.txt containing the word hi, using your tools. Then say done.')
    },
  },
  {
    name: 'approval',
    tools: ANY_TOOL,
    asksForCommands: true,
    async run(d) {
      const answer = async (text: string, decide: 'allow' | 'deny' | 'always') => {
        d.session().send(text)
        const card = await d.waitFor('an approval card', (e) => e.type === 'approval_request')
        if (card.type !== 'approval_request') return
        const matcher = decide === 'always' ? (alwaysAllowKey(card.detail) ?? undefined) : undefined
        d.session().respondApproval(card.requestId, decide, undefined, matcher)
        await d.waitFor('the end of the turn', ended)
      }
      await answer(`Run the shell command: ${commandAsked(d, 1)} . Then say done.`, 'allow')
      await answer(`Run the shell command: ${commandAsked(d, 2)} . Then say done.`, 'deny')
      await answer(`Run exactly this shell command: ${commandAsked(d, 3)} . Then say done.`, 'always')
      await turn(d, `Run exactly this shell command again: ${commandAsked(d, 3)} . Then say done.`)
    },
  },
  {
    name: 'interrupt',
    tools: ANY_TOOL,
    async run(d) {
      d.session().send('Count from 1 to 300, one number per line.')
      await d.waitFor('the first output', (e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
      await turn(d, 'Say ok.')
    },
  },
  {
    // A command that outlasts the first wait for its output (Codex hands it back as a process it keeps running), then the answer after it
    name: 'long-command',
    tools: ['codex'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Run this shell command and wait until it finishes: sleep 12 && echo long-done . Then say done.')
    },
  },
  {
    // A call to a tool of an MCP server the person set up: its arguments and its answer
    name: 'mcp-call',
    tools: ['codex'],
    preset: 'auto',
    settings: 'mcp',
    async run(d) {
      await turn(d, 'Call the ping tool of the probe MCP server once, then tell me in one word what it answered.')
    },
  },
  {
    // A command that exits with an error: the card ends not ok with the command's own words, and the turn goes on to say so
    name: 'command-failed',
    tools: ['codex'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Run this shell command: ls /no-such-folder-xyz . It is expected to fail. Then say what happened in one sentence.')
    },
  },
  {
    // A command whose output is long: the card keeps the output whole while the screen shows the start of it
    name: 'long-output',
    tools: ['codex'],
    preset: 'auto',
    async run(d) {
      await turn(d, 'Run this shell command: seq 1 3000 . Then say done.')
    },
  },
  {
    // The thread's state when it is opened again after a turn the person stopped: what the tool answers `thread/resume` with
    name: 'resume-interrupted',
    tools: ['codex'],
    async run(d) {
      d.session().send('Count from 1 to 300, one number per line.')
      await d.waitFor('the first output', (e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
      await d.reopen()
      await turn(d, 'Say ok.')
    },
  },
  {
    // ... and after a turn that failed: a model the API does not have
    name: 'resume-failed',
    tools: ['codex'],
    model: 'no-such-model-xyz',
    async run(d) {
      d.session().send('Reply with exactly: hello')
      await d.waitFor('the failure', (e) => e.type === 'error')
      await d.reopen()
    },
  },
  {
    name: 'interrupt-approval',
    tools: ANY_TOOL,
    asksForCommands: true,
    async run(d) {
      d.session().send(`Run the shell command: ${commandAsked(d, 'x')} . Then say done.`)
      await d.waitFor('an approval card', (e) => e.type === 'approval_request')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
    },
  },
  {
    name: 'queued',
    tools: ANY_TOOL,
    async run(d) {
      const session = d.session()
      if (session.sendTracked) {
        await Promise.all([session.sendTracked('Write a two-sentence story about a lighthouse.'), session.sendTracked('What is 2+2? Answer in one word.')])
        return
      }
      // A tool that names no receipt takes the second line while the first turn runs: both turns end
      session.send('Write a two-sentence story about a lighthouse.')
      session.send('What is 2+2? Answer in one word.')
      await d.waitFor('the end of the first turn', (e) => e.type === 'turn_complete')
      await d.waitFor('the end of the second turn', (e) => e.type === 'turn_complete')
    },
  },
  {
    name: 'die',
    tools: ANY_TOOL,
    async run(d) {
      d.session().send('Write a 300-word essay on tides.')
      await d.waitFor('the first output', (e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
      d.kill()
      await d.waitFor('the crash', (e) => e.type === 'error')
    },
  },
  {
    name: 'resume',
    tools: ANY_TOOL,
    async run(d) {
      await turn(d, 'Remember the code word: pelican. Reply with exactly: noted')
      await d.reopen()
      await turn(d, 'What was the code word? Answer with the word only.')
    },
  },
  {
    // Writes, then a delete: what a tool asks about each, and how it names the call it asks about (#1562 review)
    name: 'files',
    tools: ANY_TOOL,
    preset: 'auto',
    async run(d) {
      await turn(d, 'Using your file tools, not the shell: create a file named gone.txt containing x, then delete gone.txt. Then say done.')
    },
  },
  {
    name: 'compact',
    tools: ANY_TOOL,
    async run(d) {
      await turn(d, 'Reply with exactly: one')
      // As Centralu sends its own compact (`SessionEvents.sendCompact`)
      await turn(d, '/compact', { compact: true })
      await turn(d, 'What did I ask you to reply with first? One word.')
    },
  },
]

/** The scenarios recorded for `tool` */
export const scenariosFor = (tool: string): Scenario[] => SCENARIOS.filter((s) => (s.tools ?? ACP_TOOLS).includes(tool))

/**
 * Drives `adapter` through one scenario; `bound` is how long a step may wait for a real CLI (0: no bound, for replays).
 * `how.session`: what the run adds to every session it opens (a model, no settings files); `how.seed`: puts the
 * scenario's files in the real working folder of a recording run
 */
export async function drive(
  adapter: AgentAdapter,
  scenario: Scenario,
  cwd: string,
  sessionId: string,
  bound: number,
  killer: () => void,
  how: { tool?: string; session?: Partial<CreateSessionOpts>; seed?: (files: Record<string, string | Buffer>) => void } = {},
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = []
  let seen = 0
  let waiter: { pick(e: NormalizedEvent): boolean; resolve(e: NormalizedEvent): void } | null = null
  const emit = (e: NormalizedEvent) => {
    events.push(e)
    if (waiter && seen === events.length - 1) {
      seen++
      if (waiter.pick(e)) {
        const w = waiter
        waiter = null
        w.resolve(e)
      }
    }
  }
  const opts = { sessionId, cwd, permissionPreset: scenario.preset ?? ('normal' as const), projectTrusted: true, ...scenario.session?.(), ...how.session, ...(scenario.model ? { model: scenario.model } : {}) }
  let handle = await adapter.createSession(opts, emit)
  const driver: Driver = {
    events,
    tool: how.tool ?? '',
    cwd,
    seed: (files) => how.seed?.(files),
    session: () => handle,
    waitFor: (label, pick) =>
      new Promise((resolve, reject) => {
        while (seen < events.length) {
          const e = events[seen++]!
          if (pick(e)) return resolve(e)
        }
        // The bound only ends a run against a real CLI that stopped answering; a replay is ended by its test's timeout
        const timer = bound > 0 ? setTimeout(() => reject(new Error(`${scenario.name}: no ${label} within ${bound} ms`)), bound) : null
        waiter = {
          pick,
          resolve: (e) => {
            if (timer) clearTimeout(timer)
            resolve(e)
          },
        }
      }),
    reopen: async () => {
      const externalId = handle.externalId ?? undefined
      await handle.dispose()
      handle = await adapter.createSession({ ...opts, resumeExternalId: externalId }, emit)
    },
    kill: killer,
  }
  try {
    await scenario.run(driver)
  } finally {
    // A scenario that failed leaves no process behind
    await handle.dispose()
  }
  return events
}
