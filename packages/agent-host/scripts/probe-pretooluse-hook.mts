/**
 * Does a `PreToolUse` hook see every tool call, in every permission mode, and can it decide the call (#1447)?
 *
 * A session's request makes the orchestrator's turn one where every step that is not a read must be put to the person. Running the turn
 * under `default` was not enough: a tool that needs no permission (Agent, CronCreate, ScheduleWakeup, TaskStop, SendMessage) never reaches
 * `canUseTool` there (found by the review of #1516, measured with the real CLI). The SDK's own warning says "to gate every tool call, use a
 * PreToolUse hook instead". Measured here, one streaming query in `bypassPermissions` (auto) and one in `default`:
 *   - which tool names reach the hook, subagents' included (the hook input carries `agent_id` there);
 *   - that an `allow` from the hook runs the tool without a second question to `canUseTool`, and a `deny` stops it and gives the model the reason.
 *
 * One model call per turn against haiku, in a temp folder, no settings files read. Does not touch the person's ~/.centralu.
 * Run with: node --import tsx packages/agent-host/scripts/probe-pretooluse-hook.mts   (CLAUDE_PATH names the `claude` executable where `which claude`
 * finds a launcher script, as on Windows)
 */
import { query, type HookCallback, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude']).toString().split(/\r?\n/)[0]?.trim()
const claude = process.env.CLAUDE_PATH ?? found
if (!claude) throw new Error('no claude executable: set CLAUDE_PATH')

async function probe(mode: 'bypassPermissions' | 'default', decide: (tool: string) => 'allow' | 'deny', prompts: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-hook-'))
  const waiting: ((m: SDKUserMessage) => void)[] = []
  const queued: SDKUserMessage[] = []
  const send = (text: string) => {
    const m: SDKUserMessage = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }
    const w = waiting.shift()
    if (w) w(m)
    else queued.push(m)
  }
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) yield queued.shift() ?? (await new Promise<SDKUserMessage>((r) => waiting.push(r)))
  }
  const hooked: string[] = []
  const asked: string[] = []
  const hook: HookCallback = async (i) => {
    if (i.hook_event_name !== 'PreToolUse') return {}
    const agent = 'agent_id' in i && typeof i.agent_id === 'string' ? ` (subagent ${i.agent_id.slice(0, 6)})` : ''
    hooked.push(`${i.tool_name}${agent}`)
    // Looking up a deferred tool's definition is a read; the call of the tool itself is what is decided
    const permissionDecision = i.tool_name === 'ToolSearch' ? 'allow' : decide(i.tool_name)
    // A person takes their time over a card: SLOW seconds before the answer
    if (process.env.SLOW && i.tool_name !== 'ToolSearch') await new Promise((r) => setTimeout(r, Number(process.env.SLOW) * 1000))
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: 'The person decided (probe).' } }
  }
  const q = query({
    prompt: input(),
    options: {
      cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: claude,
      permissionMode: mode,
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [hook], ...(process.env.HOOK_TIMEOUT ? { timeout: Number(process.env.HOOK_TIMEOUT) } : {}) }] },
      canUseTool: async (name) => {
        asked.push(name)
        return { behavior: 'deny', message: 'canUseTool was reached (probe).' }
      },
    },
  })
  const turnDone: (() => void)[] = []
  const called: string[] = []
  void (async () => {
    for await (const msg of q) {
      if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'tool_use') called.push(b.name)
      if (msg.type === 'result') turnDone.shift()?.()
    }
  })()
  for (const p of prompts.filter((x) => !process.env.ONLY || x.includes(process.env.ONLY))) {
    hooked.length = 0
    asked.length = 0
    called.length = 0
    const done = new Promise<void>((r) => turnDone.push(r))
    send(p)
    await done
    console.log(`  [${mode}] ${p.slice(0, 70).replace(/\n/g, ' ')}\n      the model called [${called.join(', ') || 'nothing'}]; hook saw [${hooked.join(', ') || 'nothing'}]; canUseTool saw [${asked.join(', ') || 'nothing'}]; files made: [${['a.txt', 'b.txt', 'allowed.txt'].filter((f) => existsSync(join(cwd, f))).join(', ') || 'none'}]`)
  }
  return cwd
}

console.log('Every tool, bypassPermissions, the hook denies:')
await probe('bypassPermissions', () => 'deny', [
  'Use the Bash tool to run exactly: touch a.txt',
  'Use the Write tool to create b.txt containing hi.',
  'Use the CronCreate tool to schedule the prompt "say hi" to run every 30 minutes.',
  'Use the ScheduleWakeup tool to wake yourself in 120 seconds with the prompt "hi".',
  'Call the Agent tool now with subagent_type "general-purpose", description "make a file" and prompt "Use the Bash tool to run touch sub.txt, then answer done". Do not do the work yourself; the Agent tool must be called.',
  'Use the EnterPlanMode tool.',
])
console.log('default mode, the hook allows: canUseTool must not be asked again, and the command runs:')
const cwd = await probe('default', () => 'allow', ['Use the Bash tool to run exactly: touch allowed.txt'])
console.log(`  allowed.txt exists: ${existsSync(join(cwd, 'allowed.txt'))}`)
process.exit(0)
