/**
 * Manual, billable Haiku probe for #569. Do not run where sockets are blocked.
 * Run: pnpm exec tsx packages/agent-host/scripts/probe-cross-session.mts
 * Uses the person's Claude authentication; projects and CC_DATA_DIR are temporary.
 * No host is started and no process other than these two queries is stopped.
 */
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

function start(cwd: string, executable: string) {
  const input = new Input()
  const messages: SDKMessage[] = []
  let failure: unknown
  const q = query({
    prompt: input,
    options: withoutCrossSessionMessaging({
      cwd, model: 'haiku', pathToClaudeCodeExecutable: executable,
      permissionMode: 'default' as const, includePartialMessages: true, forwardSubagentText: true,
      maxTurns: 6,
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
    }),
  })
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

const root = await mkdtemp(join(tmpdir(), 'cc-cross-session-'))
const previousDataDir = process.env.CC_DATA_DIR
process.env.CC_DATA_DIR = join(root, 'data')
const sessions: ReturnType<typeof start>[] = []
try {
  const executable = toolExecutable('claude')
  if (!executable) throw new Error('Claude CLI is not installed')
  const aDir = join(root, 'a')
  const bDir = join(root, 'b')
  await Promise.all([mkdir(aDir), mkdir(bDir), mkdir(process.env.CC_DATA_DIR)])
  const b = start(bDir, executable)
  sessions.push(b)
  await b.turn('Reply READY. Do not call any tools.')
  const bInit = b.messages.find((m) => m.type === 'system' && m.subtype === 'init')
  if (!bInit || bInit.type !== 'system' || bInit.subtype !== 'init') throw new Error('B did not initialize')
  const a = start(aDir, executable)
  sessions.push(a)
  const peerTag = `CC_CROSS_SESSION_${randomUUID()}`
  const ownTag = `CC_OWN_SUBAGENT_${randomUUID()}`
  const bBaseline = b.messages.length
  const peerTurn = await a.turn(
    'Use ListAgents (or its alias ListPeers) to list other sessions if available. ' +
    `Then try SendMessage to the independent session B, session ID ${bInit.session_id}, cwd ${bDir}, ` +
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
  await b.turn('Report any messages received from another independent session since READY, quoting their text. If none, reply NONE. Use no tools.')
  const ownCalls = toolCalls(ownTurn, 'SendMessage')
  const ownCallIds = new Set(ownCalls.map((c) => c.id))
  const ownSendSucceeded = a.messages.some((m) => m.type === 'user' && Array.isArray(m.message.content) &&
    m.message.content.some((c) => c.type === 'tool_result' && ownCallIds.has(c.tool_use_id) && !c.is_error))
  const ownReply = () => a.messages.some((m) => m.type === 'assistant' && !!m.parent_tool_use_id &&
    m.message.content.some((c) => c.type === 'text' && c.text.includes(ownTag)))
  if (ownCalls.length > 0 && !ownReply()) {
    await a.until(ownReply, 'own subagent echo', 30_000).catch(() => {})
  }
  const report = {
    cliVersion: bInit.claude_code_version,
    listAgentsAvailable: aInit?.type === 'system' && aInit.subtype === 'init'
      ? aInit.tools.includes('ListAgents') || aInit.tools.includes('ListPeers') : null,
    discoveryCalls: toolCalls(peerTurn, 'ListAgents').length + toolCalls(peerTurn, 'ListPeers').length,
    crossSessionSendAttempted: toolCalls(peerTurn, 'SendMessage').length > 0,
    bReceivedPeerMessage: b.messages.slice(bBaseline).some((m) => JSON.stringify(m).includes(peerTag)),
    ownSendMessageAvailable: aInit?.type === 'system' && aInit.subtype === 'init' ? aInit.tools.includes('SendMessage') : null,
    ownBackgroundSubagentStarted: ownTurn.some((m) => m.type === 'system' && m.subtype === 'task_started' && m.is_backgrounded === true),
    ownSendMessageAttempted: ownCalls.length > 0,
    ownSendMessageSucceeded: ownSendSucceeded,
    ownSubagentReplied: ownReply(),
    observation: 'B observed through both A turns, a 5-second idle window and one B verification turn; absence is bounded evidence.',
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.listAgentsAvailable !== false || !report.crossSessionSendAttempted || report.bReceivedPeerMessage ||
      !report.ownBackgroundSubagentStarted || !report.ownSendMessageAttempted || !report.ownSendMessageSucceeded ||
      !report.ownSubagentReplied) process.exitCode = 1
} finally {
  for (const session of sessions) session.close()
  await Promise.allSettled(sessions.map((s) => s.pump))
  if (previousDataDir === undefined) delete process.env.CC_DATA_DIR
  else process.env.CC_DATA_DIR = previousDataDir
  await rm(root, { recursive: true, force: true })
}
