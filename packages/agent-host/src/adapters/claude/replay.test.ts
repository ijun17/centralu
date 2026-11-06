import { describe, expect, it } from 'vitest'
import { PermissionPreset, type NormalizedEvent } from '@cc/protocol'
import { instructionsFor, toolDefsFor } from '../../sessions/orchestrator-tools.js'
import type { AgentSpawnSpec, CreateSessionOpts } from '../contract.js'
import { callOrder, differs, loadRecording, of, recordedFolders, replaySpawner, streamJsonCodec, temporaryFolder, type OwnAnswers, type Recording } from '../frames/replay.test-helpers.js'
import { drive, scenariosFor } from '../frames/scenarios.test-helpers.js'
import { CLAUDE_SUBAGENT_TOOL, ORCHESTRATOR_MCP_NAME } from './orchestrator-mcp.js'
import { CLAUDE_RECORDINGS, CLAUDE_REPLAY_SESSION, recordedMessages, recordedVersion, replayedClaudeAdapter } from './recorded.test-helpers.js'

/**
 * The Claude adapter against recordings of the real CLI (#1498): the CLI's stream-json, recorded at its process by
 * `scripts/frames-record.mts` driving this adapter through the scenario, played back to the real SDK and adapter in place of
 * the CLI. A replay checks what the adapter sends the CLI (each line by its kind and what it answers) and what it makes of
 * what the CLI answered, and the tests below read the events it emitted. A scenario's lines were never written by hand.
 */

/**
 * What Centralu writes to the CLI itself, not the CLI: its server's answers to `initialize` and `tools/list`. They are made from the
 * tool definitions and instructions in this repository, so they are checked against those (the tools by name, words and parameters),
 * not against the copy a recording holds, which every change to a tool's words would outdate.
 */
function centraluAnswers(session: Partial<CreateSessionOpts>): OwnAnswers {
  const profile = session.toolProfile ?? 'orchestrator'
  return {
    server: ORCHESTRATOR_MCP_NAME,
    check(method, result) {
      if (method === 'initialize') return differs('the instructions', result.instructions, instructionsFor(profile, undefined, (session.apps?.current().length ?? 0) > 0, CLAUDE_SUBAGENT_TOOL), 'the code')
      const listed = Array.isArray(result.tools) ? result.tools.map((t: { name: string; description: string; inputSchema?: { properties?: object } }) => ({ name: t.name, description: t.description, parameters: Object.keys(t.inputSchema?.properties ?? {}) })) : result.tools
      return differs('the tools', listed, toolDefsFor(profile).map((t) => ({ name: t.name, description: t.description, parameters: Object.keys(t.schema.shape) })), 'the code')
    },
  }
}

type Replayed = { events: NormalizedEvent[]; problems: string[]; left: number; spawned: number; started: AgentSpawnSpec[] }

/** The recording of `scenario` played through the adapter (`edit`: changes the recording first, for a test of what a replay notices) */
async function replay(dir: string, name: string, edit?: (recording: Recording) => void): Promise<Replayed> {
  const recording = loadRecording(recordedFolders(CLAUDE_RECORDINGS).find((f) => f.dir === dir)!.file(name))
  edit?.(recording)
  const named = scenariosFor('claude').find((s) => s.name === name)!
  // Driven under the preset it was recorded with
  const preset = PermissionPreset.safeParse(recording.header.preset)
  const scenario = preset.success ? { ...named, preset: preset.data } : named
  const folder = temporaryFolder('claude-replay-')
  const cwd = folder.path
  const { spawn: replayed, state, peers } = replaySpawner(recording, streamJsonCodec(cwd, { own: centraluAnswers(scenario.session?.() ?? {}) }))
  const started: AgentSpawnSpec[] = []
  const spawn = (spec: AgentSpawnSpec) => (started.push(spec), replayed(spec))
  const adapter = replayedClaudeAdapter()
  // A step the adapter never reaches fails with what it sent instead of the recording's next line, not with a timeout
  const events = await drive(adapter, scenario, cwd, `replay-${name}`, 10_000, () => peers.at(-1)?.kill('SIGKILL'), {
    tool: 'claude',
    session: { ...CLAUDE_REPLAY_SESSION, processSource: { spawn } },
    replay: state,
  }).finally(() => folder.remove())
  return { events, problems: state.problems, left: state.left(), spawned: state.spawned, started }
}

for (const { dir, names: recorded } of recordedFolders(CLAUDE_RECORDINGS)) {
  const names = recorded.filter((n) => scenariosFor('claude').some((s) => s.name === n))
  describe(`replaying ${dir}`, () => {
    for (const name of names) {
      it(`${name}: sends what it sent to the real CLI, and uses every recorded line`, async () => {
        const r = await replay(dir, name)
        expect(r.problems).toEqual([])
        expect(r.left).toBe(0)
        expect(callOrder(r.events)).toEqual([])
      })
    }
  })
}

describe('what a replay notices', () => {
  const own = recordedVersion('centralu-mail')
  /** The recorded line of the adapter's answer to the CLI's `method` request */
  const answerTo = (recording: Recording, method: string) => {
    const asked = recording.frames.find((f) => f.dir === 'in' && (f.msg?.request as { message?: { method?: string } } | undefined)?.message?.method === method)!.msg!.request_id
    return recording.frames.find((f) => f.dir === 'out' && (f.msg?.response as { request_id?: unknown } | undefined)?.request_id === asked)!.msg as { response: { response: { mcp_response: { result: unknown } } } }
  }

  it('a change to a Centralu tool’s words needs no new recording: the recorded tools and instructions can be anything', async () => {
    const r = await replay(own, 'centralu-mail', (recording) => {
      answerTo(recording, 'tools/list').response.response.mcp_response.result = 'not even a list'
      Object.assign(answerTo(recording, 'initialize').response.response.mcp_response.result as object, { instructions: 'words from long ago' })
    })
    expect(r.problems).toEqual([])
  })

  it('a line the real CLI was sent that the adapter no longer sends fails at once, naming the recording, the line and the path', async () => {
    let line: number | undefined
    const run = replay(own, 'centralu-mail', (recording) => {
      const verdict = recording.frames.find((f) => f.dir === 'out' && (f.msg?.response as { response?: { behavior?: string } } | undefined)?.response?.behavior === 'allow')!
      ;(verdict.msg!.response as { response: { behavior: string } }).response.behavior = 'deny'
      line = verdict.line
    })
    await expect(run).rejects.toThrow(`centralu-mail.jsonl line ${line}: the adapter’s answer: first difference at response.behavior: the recording has "deny", the adapter sent "allow"`)
  })
})

const said = (events: NormalizedEvent[]) => of(events, 'message_delta').map((e) => e.text).join('')
const ended = (events: NormalizedEvent[]) => of(events, 'turn_complete').length

describe(`what the adapter makes of the CLI's real turns (${recordedVersion()})`, () => {
  const run = (name: string) => replay(recordedVersion(name), name)

  it('basic: a plain turn streams its words and ends once; a file written inside the folder under `edits` asks nothing and is marked touched', async () => {
    const { events } = await run('basic')
    expect(ended(events)).toBe(2)
    expect(of(events, 'message_delta')[0]).toMatchObject({ text: 'hello' })
    expect(of(events, 'approval_request')).toEqual([])
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Write'])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
  })

  it('tools: a read and an edit inside the folder are not asked, the command is, once; the edit marks its file', async () => {
    const { events } = await run('tools')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Read', 'Edit', 'Bash'])
    expect(of(events, 'approval_request').map((c) => c.detail)).toMatchObject([{ kind: 'command', command: 'touch tools-done.txt' }])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, true, true])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(ended(events)).toBe(1)
  })

  it('approval: three commands asked and answered allow, deny and always; the same command again is run on the rule, without a card', async () => {
    const { events } = await run('approval')
    expect(of(events, 'approval_request').map((c) => (c.detail.kind === 'command' ? c.detail.command : c.detail.kind))).toEqual(['touch probe-1.txt', 'touch probe-2.txt', 'touch probe-3.txt'])
    expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['allow', 'deny', 'always'])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, false, true, true])
    expect(ended(events)).toBe(4)
  })

  it('interrupt: a Stop in the middle of an answer ends the turn as stopped, not as a failure, and the next turn runs', async () => {
    const { events } = await run('interrupt')
    expect(of(events, 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted')).toHaveLength(1)
    expect(ended(events)).toBe(1)
    expect(said(events)).toMatch(/ok/i)
  })

  it('interrupt-tool: a Stop while a command runs ends the turn as stopped, with no failure, and the next turn runs', async () => {
    const { events } = await run('interrupt-tool')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['PowerShell'])
    expect(of(events, 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'state_change' && e.reason === 'interrupted')).toHaveLength(1)
    expect(ended(events)).toBe(1)
  })

  it('interrupt-approval: a Stop while a command waits for the person ends the card and the turn', async () => {
    const { events } = await run('interrupt-approval')
    expect(of(events, 'approval_request')).toHaveLength(1)
    expect(of(events, 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
  })

  it('background: the task is live while the turn ends, ends on its own as completed, and the CLI wakes the model with a second turn', async () => {
    const { events } = await run('background')
    const levels = of(events, 'background_tasks')
    expect(levels.find((l) => l.live.length > 0)?.live[0]).toMatchObject({ kind: 'shell', status: 'running' })
    expect(levels.flatMap((l) => l.ended ?? [])).toMatchObject([{ kind: 'shell', status: 'completed' }])
    const firstEnd = events.findIndex((e) => e.type === 'turn_complete')
    expect(events.findIndex((e) => e.type === 'background_tasks' && (e.ended?.length ?? 0) > 0)).toBeGreaterThan(firstEnd)
    expect(ended(events)).toBe(2)
  })

  it('failed: a model that does not exist ends the turn with one error in the CLI’s words, and no completed turn', async () => {
    const { events } = await run('failed')
    expect(of(events, 'error')).toHaveLength(1)
    expect(of(events, 'error')[0]!.error.message).toContain('no-such-model-xyz')
    expect(ended(events)).toBe(0)
  })

  it('big-output: a long answer arrives in order as many deltas and one turn end', async () => {
    const { events } = await run('big-output')
    const lines = said(events).trim().split('\n')
    expect(lines.slice(0, 3)).toEqual(['1', '2', '3'])
    expect(lines.at(-1)).toBe('150')
    expect(lines).toHaveLength(150)
    expect(ended(events)).toBe(1)
  })

  it('compact: the compaction is a marker with the tokens before and after, and the turns on both sides end', async () => {
    const { events } = await run('compact')
    expect(of(events, 'compaction')).toMatchObject([{ failed: false, trigger: 'manual', before: expect.any(Number), after: expect.any(Number) }])
    expect(ended(events)).toBe(3)
  })

  it('resume: the conversation goes on in a new process that knows the first one’s word', async () => {
    const { events, spawned, started } = await run('resume')
    expect(spawned).toBe(2)
    // The second process is told which conversation to go on with (the id the first one said); the first starts a new one
    const flagged = (spec: AgentSpawnSpec, name: string) => spec.args.find((a) => a === name || a.startsWith(`${name}=`)) ?? null
    expect(flagged(started[0]!, '--resume')).toBeNull()
    expect(flagged(started[1]!, '--resume')).toBe('--resume=00000003-0000-4000-8000-000000000002')
    expect(started.map((s) => s.args[s.args.indexOf('--model') + 1])).toEqual(['haiku', 'haiku'])
    expect(said(events)).toContain('pelican')
    expect(of(events, 'agent_version')).toHaveLength(2)
  })

  it('die: the CLI killed in the middle of an answer is one retryable crash that names the signal, with no completed turn', async () => {
    const { events, spawned } = await run('die')
    expect(spawned).toBe(1)
    expect(of(events, 'error')).toMatchObject([{ error: { code: 'adapter_crashed', retryable: true, message: expect.stringContaining('SIGKILL') } }])
    expect(ended(events)).toBe(0)
  })

  it('files: a file written with the Write tool is one call with its result and marks its file; a search for a tool that deletes is a call too', async () => {
    const { events } = await run('files')
    expect(of(events, 'tool_call').map((c) => c.summary.tool)).toEqual(['Write', 'ToolSearch'])
    expect(of(events, 'tool_result').map((r) => r.ok)).toEqual([true, true])
    expect(of(events, 'files_touched')).toHaveLength(1)
    expect(of(events, 'approval_request')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('queued: a message sent while a turn runs is answered after it, as its own turn', async () => {
    const { events } = await run('queued')
    expect(ended(events)).toBe(2)
    expect(said(events)).toMatch(/lighthouse[\s\S]*4/i)
  })
})

describe(`what the adapter makes of the CLI's real turns, the tools Centralu's screens draw (${recordedVersion()})`, () => {
  const run = (name: string) => replay(recordedVersion(name), name)
  const calls = (events: NormalizedEvent[]) => of(events, 'tool_call')
  const results = (events: NormalizedEvent[]) => of(events, 'tool_result')

  it("subagent: the Agent call carries the subagent's own Read and its result as steps under it, and the subagent's report is the call's result", async () => {
    const { events } = await run('subagent')
    expect(calls(events).map((c) => c.summary.tool)).toEqual(['Agent'])
    const steps = of(events, 'subagent_event')
    expect(steps.map((s) => s.parentCallId)).toEqual(steps.map(() => calls(events)[0]!.callId))
    expect(steps.map((s) => s.step.type)).toEqual(expect.arrayContaining(['tool_call', 'tool_result', 'message_delta']))
    expect(steps.find((s) => s.step.type === 'tool_call')?.step).toMatchObject({ summary: { tool: 'Read' } })
    expect(results(events)).toMatchObject([{ callId: calls(events)[0]!.callId, ok: true, summary: expect.stringContaining('The sky is red.') }])
    expect(ended(events)).toBe(1)
  })

  it('question: the choice is a question card, not an approval; the answer closes it and the tool finishes as a success the model reads', async () => {
    const { events } = await run('question')
    expect(of(events, 'approval_request')).toEqual([])
    const cards = of(events, 'question_request')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.questions[0]!.options.map((o) => o.label)).toEqual(['Red', 'Blue'])
    expect(of(events, 'question_resolved')).toMatchObject([{ requestId: cards[0]!.requestId }])
    expect(results(events)).toMatchObject([{ ok: true, summary: expect.stringContaining('"Red"') }])
    expect(said(events)).toContain('Red')
    expect(ended(events)).toBe(1)
  })

  it('question-declined: a Stop on the open choice closes the card and the tool fails as rejected; the turn ends as stopped, not as an error', async () => {
    const { events } = await run('question-declined')
    expect(of(events, 'question_request')).toHaveLength(1)
    expect(of(events, 'question_resolved')).toHaveLength(1)
    expect(results(events)).toMatchObject([{ ok: false }])
    expect(of(events, 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
  })

  it("plan: entering plan mode asks nothing, the plan is one approval card of the plan's tool, and approving it finishes the tool", async () => {
    const { events } = await run('plan')
    expect(calls(events).map((c) => c.summary.tool)).toEqual(['ToolSearch', 'EnterPlanMode', 'Write', 'ExitPlanMode'])
    const cards = of(events, 'approval_request')
    expect(cards).toHaveLength(1)
    // No plan-shaped card: the plan reaches the person as the tool's raw input (what the adapter makes of ExitPlanMode today)
    expect(cards[0]!.detail).toMatchObject({ kind: 'other', raw: expect.stringContaining('ExitPlanMode') })
    expect(of(events, 'approval_resolved').map((e) => e.decision)).toEqual(['allow'])
    expect(results(events).map((r) => r.ok)).toEqual([true, true, true, true])
    expect(ended(events)).toBe(1)
  })

  it('background-poll: a task started in the background is live, a later command in the same turn sees it end as completed, and its output file is read', async () => {
    const { events } = await run('background-poll')
    const levels = of(events, 'background_tasks')
    expect(levels.flatMap((l) => l.live).find((t) => t.parentCallId)).toMatchObject({ kind: 'shell', status: 'running', parentCallId: calls(events)[0]!.callId })
    expect(levels.flatMap((l) => l.ended ?? [])).toMatchObject([{ kind: 'shell', status: 'completed' }])
    expect(calls(events).map((c) => c.summary.tool)).toEqual(['Bash', 'Bash', 'Read'])
    expect(results(events).at(-1)).toMatchObject({ ok: true, summary: expect.stringContaining('poll-done') })
    expect(ended(events)).toBe(1)
  })

  it("background-open: the task is still running when the turn ends, and ends as stopped with the session's process", async () => {
    const { events } = await run('background-open')
    const firstEnd = events.findIndex((e) => e.type === 'turn_complete')
    expect(events.slice(0, firstEnd).some((e) => e.type === 'background_tasks' && e.live.length > 0)).toBe(true)
    expect(events.slice(0, firstEnd).some((e) => e.type === 'background_tasks' && (e.ended?.length ?? 0) > 0)).toBe(false)
    expect(of(events, 'background_tasks').flatMap((l) => l.ended ?? [])).toMatchObject([{ kind: 'shell', status: 'stopped' }])
  })

  it('centralu-mail: the mail tool is a Centralu call named by its tool, answered without a card, whatever the action', async () => {
    const { events } = await run('centralu-mail')
    const mail = calls(events).filter((c) => c.summary.centralu?.tool === 'mail')
    expect(mail.map((c) => (c.input as { action: string }).action)).toEqual(['inbox', 'send'])
    expect(of(events, 'approval_request')).toEqual([])
    expect(results(events).filter((r) => mail.some((c) => c.callId === r.callId)).map((r) => r.ok)).toEqual([true, true])
  })

  it("centralu-agents: recall, read_session and start_agent are Centralu calls with their own labels, and start_agent's answer carries the child's", async () => {
    const { events } = await run('centralu-agents')
    expect(calls(events).map((c) => c.summary.centralu?.tool)).toEqual(['recall', 'read_session', 'start_agent'])
    expect(calls(events).map((c) => c.summary.centralu?.label)).toEqual(['Searched past conversations', 'Read a session', 'Started an agent'])
    expect(results(events).map((r) => r.ok)).toEqual([true, true, true])
    expect(results(events)[2]!.summary).toContain('answered')
    expect(of(events, 'approval_request')).toEqual([])
  })

  it('centralu-compact: compact_self is a Centralu call whose answer names what will happen; the adapter itself compacts nothing', async () => {
    const { events } = await run('centralu-compact')
    expect(calls(events)).toMatchObject([{ summary: { centralu: { tool: 'compact_self', label: 'Asked to compact' } }, input: { focus: 'the naming decision' } }])
    expect(results(events)).toMatchObject([{ ok: true, summary: expect.stringContaining('Compacting after this turn') }])
    expect(of(events, 'compaction')).toEqual([])
  })

  it("mcp-app: a tool of an attached app is named by its app and tool, asks nothing as a read tool, and returns the app's words", async () => {
    const { events } = await run('mcp-app')
    const call = calls(events).find((c) => c.summary.tool === 'mcp__app-weather__forecast')
    expect(call?.summary.centralu).toEqual({ tool: 'forecast', app: 'weather' })
    expect(of(events, 'approval_request')).toEqual([])
    expect(results(events).find((r) => r.callId === call?.callId)).toMatchObject({ ok: true, summary: 'Forecast for Paris: sunny, 21 degrees.' })
  })

  it("tool-error: a command that exits with 3 and a Read of a missing file are failed results with the tool's words, and the turn still ends normally", async () => {
    const { events } = await run('tool-error')
    expect(results(events)).toMatchObject([{ ok: false, summary: 'Exit code 3\nboom' }, { ok: false, summary: expect.stringContaining('File does not exist') }])
    expect(of(events, 'error')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('long-output: a result the CLI cut is kept as the CLI handed it, a preview that names where the whole output was saved', async () => {
    const { events } = await run('long-output')
    const [result] = results(events)
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('Output too large'), output: expect.stringContaining('Full output saved to') })
    // What the CLI handed over is a short preview of 6000 lines, not the lines
    expect(result!.output!.length).toBeLessThan(5000)
    expect(result!.output).not.toContain('line 6000')
    expect(ended(events)).toBe(1)
  })

  it('markdown: a long answer with a heading, a list, a code block and a table arrives as deltas that join into the Markdown the model wrote', async () => {
    const { events } = await run('markdown')
    const text = said(events)
    expect(text).toMatch(/^#+ /m)
    expect(text).toMatch(/^[-*] /m)
    expect(text).toMatch(/```(?:ts|typescript)\n[\s\S]+\n```/)
    expect(text).toMatch(/^\|.*\|\s*\n\|[\s:|-]+\|\s*\n(\|.*\|\s*\n?){3}/m)
    expect(of(events, 'tool_call')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('image: a picture the agent reads is an image event with its type and bytes, beside a result with no text', async () => {
    const { events } = await run('image')
    expect(results(events)).toMatchObject([{ ok: true, summary: '' }])
    expect(of(events, 'message_image')).toMatchObject([{ mime: 'image/png', data: expect.stringMatching(/^iVBOR/) }])
    expect(said(events)).toMatch(/red/i)
  })

  it('powershell: a turn on the PowerShell tool is a command call, run under auto without a card, with its output', async () => {
    const { events } = await run('powershell')
    expect(calls(events)).toMatchObject([{ summary: { tool: 'PowerShell', title: 'Write-Output "ps-ok"' } }])
    expect(of(events, 'approval_request')).toEqual([])
    expect(results(events)).toMatchObject([{ ok: true, summary: 'ps-ok' }])
  })

  it('todo: each TaskCreate adds a step to the plan from the id its result names, and a TaskUpdate marks one completed; the plan is a whole snapshot each time', async () => {
    const { events } = await run('todo')
    expect(calls(events).map((c) => c.summary.tool).filter((t) => t.startsWith('Task'))).toEqual(['TaskCreate', 'TaskCreate', 'TaskUpdate'])
    expect(of(events, 'plan_update').map((p) => p.steps)).toEqual([
      [{ text: 'write the intro', status: 'pending' }],
      [{ text: 'write the intro', status: 'pending' }, { text: 'write the outro', status: 'pending' }],
      [{ text: 'write the intro', status: 'completed' }, { text: 'write the outro', status: 'pending' }],
    ])
    expect(of(events, 'approval_request')).toEqual([])
    expect(ended(events)).toBe(1)
  })

  it('thinking: the thinking the CLI shows arrives as reasoning text before the answer, not as an empty block, and the turn ends once', async () => {
    const { events } = await run('thinking')
    const reasoning = of(events, 'reasoning_delta').map((e) => e.text ?? '').join('')
    // Exactly the words the CLI streamed: the finished message repeats them, and the adapter does not say them twice (`reasoningStreamed`)
    const streamed = recordedMessages('thinking')
      .flatMap((m) => ((m as { event?: { delta?: { type?: string; thinking?: string } } }).event?.delta?.type === 'thinking_delta' ? [(m as { event: { delta: { thinking: string } } }).event.delta.thinking] : []))
      .join('')
    expect(streamed).toMatch(/17/)
    expect(reasoning).toBe(streamed)
    // ...as deltas, one per streamed piece: the same words once from the finished message would also join to `streamed`
    const pieces = recordedMessages('thinking').filter((m) => (m as { event?: { delta?: { type?: string; thinking?: string } } }).event?.delta?.type === 'thinking_delta' && !!(m as { event: { delta: { thinking: string } } }).event.delta.thinking)
    expect(of(events, 'reasoning_delta').filter((e) => !!e.text)).toHaveLength(pieces.length)
    expect(events.findIndex((e) => e.type === 'reasoning_delta' && !!e.text)).toBeLessThan(events.findIndex((e) => e.type === 'message_delta'))
    expect(said(events)).toContain('391')
    expect(ended(events)).toBe(1)
  })

  it('web: a page fetched and a search made are calls of their tools, run under auto without a card, each with its words as the result', async () => {
    const { events } = await run('web')
    expect(calls(events).map((c) => c.summary.tool).filter((t) => t.startsWith('Web'))).toEqual(['WebFetch', 'WebSearch'])
    expect(calls(events).find((c) => c.summary.tool === 'WebFetch')!.input).toMatchObject({ url: 'https://example.com' })
    expect(of(events, 'approval_request')).toEqual([])
    expect(results(events).slice(-2)).toMatchObject([{ ok: true, summary: expect.stringContaining('Example Domain') }, { ok: true, summary: expect.stringContaining('Web search results') }])
    expect(ended(events)).toBe(1)
  })

  it("mcp-call: a tool of an MCP server of the person's own is named by its server and tool, asks nothing under auto, and returns the server's text", async () => {
    const { events } = await run('mcp-call')
    // The model first looks the tool up (ToolSearch), as the tools of an MCP server are deferred
    const ping = calls(events).find((c) => c.summary.tool === 'mcp__probe__ping')
    expect(ping).toBeDefined()
    expect(of(events, 'approval_request')).toEqual([])
    expect(results(events).find((r) => r.callId === ping!.callId)).toMatchObject({ ok: true, summary: 'pong' })
    expect(ended(events)).toBe(1)
  })
})
