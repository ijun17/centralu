/**
 * What happens to a Claude session's background tasks when the turn is interrupted, or one task is
 * stopped (#290).
 *
 * One haiku turn in a throwaway folder that launches a background subagent (the Agent tool with
 * `run_in_background`) and a backgrounded Bash, then runs a foreground `sleep` so the turn is still
 * going. Once both tasks are in `background_tasks_changed`:
 *
 *   --mode interrupt   calls `query.interrupt()` mid-turn
 *   --mode stop        waits for the turn to end, then calls `query.stopTask(<the shell's id>)`
 *
 * and keeps reading for 25 seconds. Prints every task-related system message, the turn's results, and
 * whether the two `sleep` processes are still alive afterwards (each has its own duration to find it).
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-background-tasks.mts --mode interrupt
 * (one small haiku turn plus one subagent turn)
 *
 * Measured (2026-10-04, CLI 2.1.282, SDK 0.3.263, haiku):
 *   - Each launch arrives as `background_tasks_changed` (the whole live set: task_id, task_type, description; no
 *     tool_use_id) and then `task_started` (task_id, tool_use_id, task_type `local_bash` / `local_agent`,
 *     is_backgrounded, `owned_by_subagent` for a shell a subagent started). The level came first every time.
 *   - interrupt, mid-turn, 8 s after both launched: the **subagent stopped** — `background_tasks_changed` without it,
 *     `task_updated {status: 'killed'}`, `task_notification {status: 'stopped', tool_use_id}` in the same millisecond,
 *     then `result/error_during_execution`. The **backgrounded shell kept running**: still in the live set and its
 *     `sleep` still alive 25 s later. Same result interrupting 50 ms after launch.
 *   - stopTask(<the shell's id>) after the turn ended: `background_tasks_changed` without it, `task_updated
 *     {status: 'killed'}`, `task_notification {status: 'stopped'}`; the process was gone.
 *   - A shell a subagent started (`owned_by_subagent`) outlived that subagent's completion.
 *   - `close()` killed the remaining shell, and nothing was emitted for it.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mode = process.argv[process.argv.indexOf('--mode') + 1] === 'stop' ? 'stop' : 'interrupt'
const cwd = mkdtempSync(join(tmpdir(), 'cc-bg-tasks-'))
const SHELL = 'sleep 191; echo bg-shell-done'
const SUB = 'sleep 192; echo bg-sub-done'

const prompt =
  'Do exactly these three things in order, without commentary. ' +
  `1. Call the Bash tool with run_in_background true and the command \`${SHELL}\`. ` +
  '2. Call the Agent tool exactly once (subagent_type "general-purpose", description "probe sleeper", run_in_background true) ' +
  `with this prompt: "Run the Bash command \`${SUB}\` in the foreground and then reply done." ` +
  '3. Call the Bash tool in the foreground with the command `sleep 30; echo fg-done`. ' +
  'Then reply with one word.'

let open = true
let wake: () => void = () => {}
async function* input() {
  yield {
    type: 'user' as const,
    parent_tool_use_id: null,
    session_id: '',
    message: { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
  }
  while (open) await new Promise<void>((r) => (wake = r))
}

const q = query({
  prompt: input(),
  options: {
    cwd,
    pathToClaudeCodeExecutable: execFileSync('which', ['claude']).toString().trim(),
    model: 'haiku',
    includePartialMessages: false,
    settingSources: [],
    permissionMode: 'default',
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      const cmd = String(input.command ?? '')
      if (name === 'Agent' || name === 'Task' || (name === 'Bash' && /^sleep (191|192|30);/.test(cmd))) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return { behavior: 'deny' as const, message: 'probe: not allowed' }
    },
  } as never,
})

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
const alive = () => {
  const ps = execFileSync('ps', ['-axo', 'pid,command']).toString()
  return { shell: /sleep 191/.test(ps), sub: /sleep 192/.test(ps) }
}
let live: { task_id: string; task_type: string; description: string; ambient?: boolean }[] = []
const started = new Map<string, string>()
let acted = false
let endAt = Number.POSITIVE_INFINITY
let resultSeen = false
const timer = setTimeout(() => {
  console.log('!! timed out')
  process.exit(1)
}, 170_000)

const act = async () => {
  acted = true
  // Let the subagent reach its own `sleep` first, so what is stopped is a task that is really running.
  await new Promise((r) => setTimeout(r, 8000))
  console.log(`${ms()} -- live before acting: ${JSON.stringify(live)} alive=${JSON.stringify(alive())}`)
  if (mode === 'interrupt') {
    console.log(`${ms()} -- query.interrupt()`)
    await q.interrupt()
  } else {
    const shell = live.find((t) => t.task_type === 'local_bash' || /191/.test(t.description))
    console.log(`${ms()} -- query.stopTask(${shell?.task_id})`)
    if (shell) await q.stopTask(shell.task_id)
  }
  endAt = Date.now() + 25_000
  setTimeout(() => {
    open = false
    wake()
  }, 25_000)
}

const it = q[Symbol.asyncIterator]()
while (Date.now() < endAt) {
  const wait = Number.isFinite(endAt) ? [new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, endAt - Date.now())))] : []
  const next = await Promise.race([it.next(), ...wait])
  if (next === null || next.done) break
  const m = next.value as Record<string, unknown>
  if (m.type === 'system') {
    const sub = String(m.subtype)
    if (sub === 'init') continue
    const keys = Object.keys(m).filter((k) => !['type', 'subtype', 'uuid', 'session_id', 'output_file'].includes(k))
    const pick = Object.fromEntries(keys.map((k) => [k, typeof m[k] === 'string' ? String(m[k]).slice(0, 100) : m[k]]))
    console.log(`${ms()} system/${sub} ${JSON.stringify(pick).slice(0, 500)}`)
    if (sub === 'background_tasks_changed') live = m.tasks as typeof live
    if (sub === 'task_started') started.set(String(m.task_id), String(m.tool_use_id ?? ''))
  } else if (m.type === 'result') {
    resultSeen = true
    console.log(`${ms()} result/${String(m.subtype)}`)
  } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
    const content = ((m.message as Record<string, unknown>).content ?? []) as Record<string, unknown>[]
    console.log(`${ms()} assistant [${content.map((b) => (b.type === 'tool_use' ? `tool_use(${String(b.name)} ${String(b.id)})` : String(b.type))).join(', ')}]`)
  } else if (m.type === 'user' && !m.parent_tool_use_id) {
    const c = (m.message as Record<string, unknown>).content
    const blocks = Array.isArray(c) ? (c as Record<string, unknown>[]).map((b) => `${String(b.type)}(${String(b.tool_use_id ?? '')} ${JSON.stringify(b.content ?? '').slice(0, 80)})`) : [JSON.stringify(c).slice(0, 80)]
    console.log(`${ms()} user [${blocks.join(', ')}]`)
  }
  const ready = live.filter((t) => !t.ambient).length >= 2
  if (!acted && ready && (mode === 'interrupt' ? !resultSeen : resultSeen)) void act()
}
console.log(`${ms()} -- after: live=${JSON.stringify(live)} alive=${JSON.stringify(alive())}`)
clearTimeout(timer)
open = false
wake()
q.close()
await new Promise((r) => setTimeout(r, 2000))
console.log(`${ms()} -- after close: alive=${JSON.stringify(alive())}`)
process.exit(0)
