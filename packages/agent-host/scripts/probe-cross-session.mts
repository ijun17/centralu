/**
 * Manual, billable Haiku probe for #569 and the mailbox plan's slice 0 (§9.6). Do not run where sockets are blocked.
 * Run: pnpm exec tsx packages/agent-host/scripts/probe-cross-session.mts [case ...]
 * Uses the person's Claude authentication; projects and CC_DATA_DIR are temporary.
 * No host is started and no process other than these queries is stopped.
 *
 * Two sessions, A (the sender) and B (the receiver), run in the same machine. A addresses B by the name B registered in
 * ~/.claude/sessions/<pid>.json (and its `uds:` pipe when B bound one): the CLI does not deliver to a session UUID, so
 * addressing by UUID reports "unreachable" with the controls on or off. The cases (default: all):
 *   normal, auto       Centralu's controls on, under the `normal` and `auto` presets: the channel must be closed. `list`:
 *                      ListAgents is not offered; `send`: A's SendMessage to B reaches nothing; `refused`: B never read it,
 *                      before or after a turn of its own. A's own background subagent still takes a SendMessage.
 *   auto-accept-file   As `auto`, with both folders' project settings asking for `crossSessionInbound: accept`: the inline
 *                      layer must still win.
 *   in-from-raw        Mixed: an uncontrolled sender (an older host's session, the person's own CLI) to a controlled receiver:
 *                      the receiver has no inbox to reach.
 *   out-to-raw         Mixed: a controlled sender to an uncontrolled receiver: the sender may not send (nor its subagent).
 *   kite-on-b          An uncontrolled sender to a controlled B whose settings `env` turns CLAUDE_CODE_HARBOR_KITE back on (the person's user settings
 *                      can): B binds its inbox again, and only `crossSessionInbound: refuse` keeps the message unread.
 *   raw-auto           Control: both sessions under `auto` with NO controls (what Centralu did before slice 0). Shows the
 *                      probe can see a leak: ListAgents is offered and B reads the message.
 *   raw-held           Control: A prompting, B bypass, no controls. The CLI's default holds mail from another class at a
 *                      receiver that runs without asking; `held` is whether B had it before its own turn, `released` after.
 * The controlled cases decide the exit code (1); a control that shows no leak says the probe is blind (exit 3).
 */
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withoutCrossSessionMessaging } from '../src/adapters/claude/cross-session.js'
import { toolExecutable } from '../src/tool-launch.js'

class Input {
  private pending: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private ended = false

  send(text: string) {
    this.pending.push({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } })
    this.wake?.()
  }

  close() {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const next = this.pending.shift()
      if (next) yield next
      else await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}

type Mode = { permissionMode: 'default' | 'bypassPermissions'; controls: boolean; settingSources?: ('user' | 'project' | 'local')[]; settings?: Record<string, unknown> }

function start(cwd: string, executable: string, mode: Mode) {
  const input = new Input()
  const messages: SDKMessage[] = []
  let failure: unknown
  const base = {
    cwd, model: 'haiku', pathToClaudeCodeExecutable: executable,
    ...(mode.settingSources ? { settingSources: mode.settingSources } : {}),
    ...(mode.settings ? { settings: mode.settings } : {}),
    permissionMode: mode.permissionMode, includePartialMessages: true, forwardSubagentText: true,
    maxTurns: 6,
    // Under bypassPermissions canUseTool is not asked, so the tools a session must not use are denied by name
    disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep'],
    canUseTool: async (name: string, toolInput: Record<string, unknown>) =>
      ['Agent', 'Task', 'SendMessage', 'ListAgents', 'ListPeers'].includes(name)
        ? { behavior: 'allow' as const, updatedInput: toolInput }
        : { behavior: 'deny' as const, message: 'This probe only exercises agent messaging.' },
    agents: {
      'probe-echo': {
        description: 'Echoes a follow-up message to verify own-subagent messaging.',
        prompt: 'Reply READY to the initial request. On a follow-up message, reply with exactly its text. Use no tools.',
        model: 'haiku', tools: [], maxTurns: 2,
      },
    },
  }
  const q = query({ prompt: input, options: mode.controls ? withoutCrossSessionMessaging(base) : base })
  const pump = (async () => {
    try {
      for await (const message of q) messages.push(message)
    } catch (error) {
      failure = error
    }
  })()

  async function until(check: () => boolean, label: string, timeout = 90_000) {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (failure) throw failure
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
      await delay(100)
    }
  }

  async function turn(text: string) {
    const from = messages.length
    input.send(text)
    await until(() => messages.slice(from).some((m) => m.type === 'result'), 'model turn')
    const result = messages.slice(from).find((m) => m.type === 'result')!
    if (result.type === 'result' && result.subtype !== 'success') throw new Error(`Turn failed: ${result.subtype}`)
    return messages.slice(from)
  }

  return { messages, turn, until, close: () => { input.close(); q.close() }, pump }
}

function toolCalls(messages: SDKMessage[], name: string) {
  return messages.flatMap((m) => m.type === 'assistant'
    ? m.message.content.flatMap((b) => b.type === 'tool_use' && b.name === name ? [b] : []) : [])
}


function toolResults(messages: SDKMessage[], ids: Set<string>) {
  return messages.flatMap((m) => m.type === 'user' && Array.isArray(m.message.content)
    ? m.message.content.flatMap((c) => c.type === 'tool_result' && ids.has(c.tool_use_id)
        ? [{ isError: !!c.is_error, text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300) }] : []) : [])
}

type Case = { name: string; a: Mode; b: Mode; controlled: boolean; /** Project settings files that set crossSessionInbound to accept, in both folders */ acceptFile?: boolean }
const CASES: Case[] = [
  { name: 'normal', a: { permissionMode: 'default', controls: true }, b: { permissionMode: 'default', controls: true }, controlled: true },
  { name: 'auto', a: { permissionMode: 'bypassPermissions', controls: true }, b: { permissionMode: 'bypassPermissions', controls: true }, controlled: true },
  // The person's own project settings ask for the channel: the inline layer must still win
  { name: 'auto-accept-file', a: { permissionMode: 'bypassPermissions', controls: true, settingSources: ['user', 'project', 'local'] }, b: { permissionMode: 'bypassPermissions', controls: true, settingSources: ['user', 'project', 'local'] }, controlled: true, acceptFile: true },
  { name: 'in-from-raw', a: { permissionMode: 'bypassPermissions', controls: false }, b: { permissionMode: 'bypassPermissions', controls: true }, controlled: true },
  { name: 'out-to-raw', a: { permissionMode: 'bypassPermissions', controls: true }, b: { permissionMode: 'bypassPermissions', controls: false }, controlled: true },
  { name: 'kite-on-b', a: { permissionMode: 'bypassPermissions', controls: false }, b: { permissionMode: 'bypassPermissions', controls: true, settings: { env: { CLAUDE_CODE_HARBOR_KITE: '1' } } }, controlled: true },
  { name: 'raw-auto', a: { permissionMode: 'bypassPermissions', controls: false }, b: { permissionMode: 'bypassPermissions', controls: false }, controlled: false },
  { name: 'raw-held', a: { permissionMode: 'default', controls: false }, b: { permissionMode: 'bypassPermissions', controls: false }, controlled: false },
]

type Registered = { name: string; socket: string | null }

/** What B registered for the other sessions to find it by: its name, and the pipe it bound (none when its inbox is closed) */
async function registeredAs(sessionId: string): Promise<Registered | null> {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions')
  for (let tries = 0; tries < 20; tries++) {
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue
      const entry = await readFile(join(dir, file), 'utf8').then((text): unknown => JSON.parse(text)).catch(() => null)
      if (typeof entry === 'object' && entry !== null && 'sessionId' in entry && entry.sessionId === sessionId && 'name' in entry && typeof entry.name === 'string') {
        return { name: entry.name, socket: 'messagingSocketPath' in entry && typeof entry.messagingSocketPath === 'string' ? entry.messagingSocketPath : null }
      }
    }
    await delay(500)
  }
  return null
}

async function runCase(c: Case, root: string, executable: string) {
  const sessions: ReturnType<typeof start>[] = []
  try {
    const aDir = join(root, `${c.name}-a`)
    const bDir = join(root, `${c.name}-b`)
    await Promise.all([mkdir(join(aDir, '.claude'), { recursive: true }), mkdir(join(bDir, '.claude'), { recursive: true })])
    if (c.acceptFile) for (const d of [aDir, bDir]) await writeFile(join(d, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'accept' }))
    const b = start(bDir, executable, c.b)
    sessions.push(b)
    await b.turn('Reply READY. Do not call any tools.')
    const bInit = b.messages.find((m) => m.type === 'system' && m.subtype === 'init')
    if (!bInit || bInit.type !== 'system' || bInit.subtype !== 'init') throw new Error('B did not initialize')
    const target = await registeredAs(bInit.session_id)
    if (!target) throw new Error('B never registered a name in the CLI session registry')
    const a = start(aDir, executable, c.a)
    sessions.push(a)
    const peerTag = `CC_CROSS_SESSION_${randomUUID()}`
    const ownTag = `CC_OWN_SUBAGENT_${randomUUID()}`
    const bBaseline = b.messages.length
    const peerTurn = await a.turn(
      'Use ListAgents (or its alias ListPeers) to list other sessions if available. ' +
      `Then try SendMessage to the independent session B, by its name "${target.name}"` +
      (target.socket ? `, and if that fails by the address "uds:${target.socket}"` : '') + ', ' +
      `with this exact text: ${peerTag}. Attempt the send even if discovery is unavailable. ` +
      'Do not message any other independent session. Use no other tools. Briefly report any refusal.',
    )
    const aInit = a.messages.find((m) => m.type === 'system' && m.subtype === 'init')
    const ownTurn = await a.turn(
      'Use Agent to launch one probe-echo subagent with run_in_background=true and the prompt "Reply READY". ' +
      'Then use SendMessage to that own subagent using the agent ID returned by Agent, ' +
      `with this exact text: ${ownTag}. Do not use Agent's resume option. Use no other tools.`,
    )
    // Accepted peer traffic may enter while idle or at the next tool/turn boundary.
    await delay(5_000)
    const bSawBeforeTurn = b.messages.slice(bBaseline).some((m) => JSON.stringify(m).includes(peerTag))
    await b.turn('Report any messages received from another independent session since READY, quoting their text. If none, reply NONE. Use no tools.')
    const bSawAfterTurn = b.messages.slice(bBaseline).some((m) => JSON.stringify(m).includes(peerTag))
    const ownCalls = toolCalls(ownTurn, 'SendMessage')
    const ownCallIds = new Set(ownCalls.map((x) => x.id))
    const ownSendSucceeded = toolResults(a.messages, ownCallIds).some((r) => !r.isError)
    const ownReply = () => a.messages.some((m) => m.type === 'assistant' && !!m.parent_tool_use_id &&
      m.message.content.some((x) => x.type === 'text' && x.text.includes(ownTag)))
    if (ownCalls.length > 0 && !ownReply()) await a.until(ownReply, 'own subagent echo', 90_000).catch(() => {})
    const peerCalls = toolCalls(peerTurn, 'SendMessage')
    const listCalls = [...toolCalls(peerTurn, 'ListAgents'), ...toolCalls(peerTurn, 'ListPeers')]
    return {
      case: c.name,
      cliVersion: bInit.claude_code_version,
      list: {
        offered: aInit?.type === 'system' && aInit.subtype === 'init' ? aInit.tools.includes('ListAgents') || aInit.tools.includes('ListPeers') : null,
        calls: listCalls.length,
        results: toolResults(a.messages, new Set(listCalls.map((x) => x.id))),
      },
      send: { attempted: peerCalls.length > 0, results: toolResults(a.messages, new Set(peerCalls.map((x) => x.id))) },
      b: { name: target.name, boundItsInbox: target.socket !== null },
      bSawBeforeItsTurn: bSawBeforeTurn,
      bSawAfterItsTurn: bSawAfterTurn,
      own: {
        sendMessageOffered: aInit?.type === 'system' && aInit.subtype === 'init' ? aInit.tools.includes('SendMessage') : null,
        backgroundSubagentStarted: ownTurn.some((m) => m.type === 'system' && m.subtype === 'task_started' && m.is_backgrounded === true),
        sendAttempted: ownCalls.length > 0,
        sendSucceeded: ownSendSucceeded,
        subagentReplied: ownReply(),
      },
    }
  } finally {
    for (const session of sessions) session.close()
    await Promise.allSettled(sessions.map((s) => s.pump))
  }
}

const root = await mkdtemp(join(tmpdir(), 'cc-cross-session-'))
const previousDataDir = process.env.CC_DATA_DIR
// Run inside a Claude session, the probe inherits that session's inbox: the uncontrolled cases must not register it
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
delete process.env.CLAUDE_CODE_MESSAGING_TOKEN
process.env.CC_DATA_DIR = join(root, 'data')
try {
  const executable = toolExecutable('claude')
  if (!executable) throw new Error('Claude CLI is not installed')
  await mkdir(process.env.CC_DATA_DIR)
  const wanted = process.argv.slice(2)
  const cases = wanted.length ? CASES.filter((c) => wanted.includes(c.name)) : CASES
  if (!cases.length) throw new Error(`Unknown case; choose from ${CASES.map((c) => c.name).join(', ')}`)
  for (const c of cases) {
    const r = await runCase(c, root, executable)
    console.log(JSON.stringify({ ...r, note: 'B is observed through both A turns, a 5-second idle window and one B turn; absence is bounded evidence.' }, null, 2))
    if (c.controlled) {
      const closed = (!c.a.controls || r.list.offered === false) && r.send.attempted && !r.bSawBeforeItsTurn && !r.bSawAfterItsTurn
      // `subagentReplied` is shown, not judged: a Haiku subagent does not always answer within the wait, and the control is that SendMessage to it still goes through
      // A's own subagent is only asked of a controlled A: an uncontrolled one proves nothing about the controls
      const ownWorks = !c.a.controls || (r.own.backgroundSubagentStarted && r.own.sendAttempted && r.own.sendSucceeded)
      if (!closed || !ownWorks) process.exitCode = 1
    } else if (c.name === 'raw-auto' && !r.bSawAfterItsTurn) {
      // The control showed no leak: a pass in the controlled cases would prove nothing
      console.error('raw-auto delivered nothing: the probe cannot see a leak here')
      process.exitCode = 3
    }
  }
} finally {
  if (previousDataDir === undefined) delete process.env.CC_DATA_DIR
  else process.env.CC_DATA_DIR = previousDataDir
  await rm(root, { recursive: true, force: true })
}
