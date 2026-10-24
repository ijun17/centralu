/**
 * Can the permission mode be narrowed for one turn of a running session, and put back (#1447, the turn of a session's request to the orchestrator)?
 *
 * Under `auto` the CLI runs in `bypassPermissions`, so `canUseTool` is never reached for Bash or a file edit. A turn that a session's
 * request started has to ask the person for every step that is not a read, so the adapter switches the live query to `default` for that
 * turn (`Query.setPermissionMode`) and back after it. Measured here, in one streaming query:
 *   1. bypass, a Bash call:               the callback is not reached, the command runs
 *   2. after setPermissionMode('default'): the callback is reached for Bash, a deny stops the command
 *   3. the same, a Write                   the callback is reached
 *   4. after setPermissionMode('bypassPermissions'): the callback is not reached again, the command runs
 *
 * One model call per turn against haiku, in a temp folder, no settings files read, nothing persisted. Does not touch the person's
 * ~/.centralu. Run with: node --import tsx packages/agent-host/scripts/probe-request-turn-mode.mts
 * (CLAUDE_PATH names the `claude` executable where `which claude` finds a launcher script, as on Windows.)
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude']).toString().split(/\r?\n/)[0]?.trim()
const claude = process.env.CLAUDE_PATH ?? found
if (!claude) throw new Error('no claude executable: set CLAUDE_PATH')
const cwd = mkdtempSync(join(tmpdir(), 'cc-turn-mode-'))

const waiting: ((m: SDKUserMessage) => void)[] = []
const queued: SDKUserMessage[] = []
const send = (text: string) => {
  const m: SDKUserMessage = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }
  const w = waiting.shift()
  if (w) w(m)
  else queued.push(m)
}
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    const next = queued.shift()
    yield next ?? (await new Promise<SDKUserMessage>((r) => waiting.push(r)))
  }
}

const seen: string[] = []
const q = query({
  prompt: input(),
  options: {
    cwd,
    model: 'haiku',
    pathToClaudeCodeExecutable: claude,
    permissionMode: 'bypassPermissions',
    settingSources: [],
    canUseTool: async (name) => {
      seen.push(name)
      return { behavior: 'deny', message: 'The person denied it (probe).' }
    },
  },
})

const turnDone: (() => void)[] = []
void (async () => {
  for await (const msg of q) if (msg.type === 'result') turnDone.shift()?.()
})()

async function runTurn(label: string, prompt: string, mode: 'bypassPermissions' | 'default'): Promise<void> {
  await q.setPermissionMode(mode)
  seen.length = 0
  const done = new Promise<void>((r) => turnDone.push(r))
  send(prompt)
  await done
  console.log(`${label} (mode ${mode}): callback saw [${seen.join(', ') || 'nothing'}]`)
}

await runTurn('1', 'Use the Bash tool to run exactly: touch a.txt\nThen reply with one short sentence.', 'bypassPermissions')
console.log(`   a.txt exists: ${existsSync(join(cwd, 'a.txt'))}`)
await runTurn('2', 'Use the Bash tool to run exactly: touch b.txt\nThen reply with one short sentence.', 'default')
console.log(`   b.txt exists: ${existsSync(join(cwd, 'b.txt'))}`)
await runTurn('3', 'Use the Write tool to create c.txt containing the word hi.\nThen reply with one short sentence.', 'default')
console.log(`   c.txt exists: ${existsSync(join(cwd, 'c.txt'))}`)
await runTurn('4', 'Use the Bash tool to run exactly: touch d.txt\nThen reply with one short sentence.', 'bypassPermissions')
console.log(`   d.txt exists: ${existsSync(join(cwd, 'd.txt'))}`)
process.exit(0)
