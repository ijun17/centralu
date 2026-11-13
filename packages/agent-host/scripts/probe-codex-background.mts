/**
 * What happens to a Codex child agent when the parent's turn is interrupted, or when its own turn is (#290).
 *
 * Drives `codex app-server` directly in a throwaway folder. One parent turn spawns one child that runs a long `sleep`,
 * does not wait for it, and runs a shorter `sleep` of its own so the parent's turn is still going. Then:
 *
 *   --mode interrupt   once the child's command has started, `turn/interrupt` on the **parent's** turn
 *   --mode stop        once the parent's turn has ended, `turn/interrupt` on the **child's** turn
 *
 * and keeps reading for 20 seconds. Prints the timeline (threads, statuses, turns, collab items) and whether the
 * child's `sleep` process is still alive. The parent thread is deleted at the end.
 *
 * Run with: PROBE_MODEL=gpt-5.6-luna node --import tsx packages/agent-host/scripts/probe-codex-background.mts --mode interrupt
 * (one small parent turn plus one child turn, at effort low)
 *
 * Measured (2026-10-04, codex-cli 0.160.0, gpt-5.6-luna, effort low):
 *   - The child's `thread/status/changed {idle}` then `{active}` and its `turn/started` arrive in the same millisecond
 *     as the parent's `spawnAgent` `item/completed` that names it (`receiverThreadIds`, `agentsStates: pendingInit`).
 *   - interrupt on the parent's turn: the parent's `turn/completed {status: 'interrupted'}` and `{idle}`. The **child
 *     kept running**: still active, it went on reasoning, and its `sleep` was alive 20 s later. It ended only when the
 *     parent thread was deleted (`turn/completed {status: 'interrupted'}` on the child).
 *   - interrupt on the child's own turn (`turn/interrupt {threadId: child, turnId: child's}`): `{idle}` then
 *     `turn/completed {status: 'interrupted'}` on the child, in the same millisecond. The child's shell process was
 *     still alive 20 s later (Codex does not kill a running command on interrupt); it went with the app-server.
 *
 * `--inventory shell|goal` (#2027, docs/plans/sleep-every-tool.md §4, §11): what a Codex session holds once its turn has ended,
 * which decides whether putting it to sleep (ending its app-server) can end running work.
 *
 *   --inventory shell   two turns, each asked to start a `sleep` that keeps running after the turn (a process Codex keeps, not `&`).
 *                       Turn 1 (`sleep 23`): which `commandExecution` items are still `inProgress` at `turn/completed`, whether the
 *                       `sleep` is alive then, and whether its `item/completed` (with which `exitCode`) arrives after the turn,
 *                       watched for 45 s. Turn 2 (`sleep 197`): the app-server is closed 5 s after the turn ended, and whether the
 *                       `sleep` is still alive 3 s later says whether a sleep would end it
 *   --inventory goal    `thread/goal/set` on an idle thread (no `turn/start` sent), then 5 minutes watched: every `turn/started`
 *                       the probe did not ask for, every goal notification, and the goal's status at the end
 *
 * Each prints a `RESULT` line per question, the line the plan's §3a quotes.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { CodexClient, ServerNotification } from '../src/adapters/codex/client.js'
import { probeDir, openProbe } from './codex-probe-kit.mjs'

const arg = (name: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const inventory = arg('--inventory')
if (inventory === 'shell') await inventoryShell()
else if (inventory === 'goal') await inventoryGoal()
else await childMode()
process.exit(0)

async function childMode(): Promise<void> {
  const mode = arg('--mode') === 'stop' ? 'stop' : 'interrupt'
  const dir = probeDir('cc-codex-bg-')
  const { cwd, log, t0 } = dir
  const ms = () => String(Date.now() - t0).padStart(6)
  const childAlive = () => /sleep 193/.test(execFileSync('ps', ['-axo', 'pid,command']).toString())

  let parent = ''
  let parentTurn = ''
  const childTurns = new Map<string, string>()
  let childCommandStarted = false
  let parentDone = false
  let acted = false
  let stopAt = 0

  const act = async (client: CodexClient) => {
    acted = true
    console.log(
      `${ms()} -- before acting: childAlive=${childAlive()} childTurns=${JSON.stringify([...childTurns])}`,
    )
    if (mode === 'interrupt') {
      console.log(`${ms()} -- turn/interrupt parent ${parentTurn}`)
      console.log(
        `${ms()} -- reply ${JSON.stringify(await client.request('turn/interrupt', { threadId: parent, turnId: parentTurn }).catch((e: Error) => e.message))}`,
      )
    } else {
      const [thread, turn] = [...childTurns][0] ?? []
      console.log(`${ms()} -- turn/interrupt child ${thread} ${turn}`)
      if (thread && turn)
        console.log(
          `${ms()} -- reply ${JSON.stringify(await client.request('turn/interrupt', { threadId: thread, turnId: turn }).catch((e: Error) => e.message))}`,
        )
    }
    stopAt = Date.now() + 20_000
  }

  const { client } = await openProbe(dir, {
    record: false,
    onNotification: (n, client) => {
      appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, n }) + '\n')
      if (n.method.endsWith('/delta') || n.method.includes('Delta')) return
      const p = (n.params ?? {}) as Record<string, unknown>
      const from = String(p.threadId ?? '')
      const who = from === parent ? 'parent' : from ? `child ${from.slice(-6)}` : '-'
      const item = p.item as Record<string, unknown> | undefined
      const turn = p.turn as Record<string, unknown> | undefined
      let tag = ''
      if (n.method === 'thread/status/changed') tag = ` ${JSON.stringify(p.status)}`
      if (turn) tag = ` turn=${String(turn.id)} status=${String(turn.status)}`
      if (item) tag = ` ${String(item.type)}`
      if (item?.type === 'collabAgentToolCall')
        tag += ` tool=${String(item.tool)} status=${String(item.status)} receivers=${JSON.stringify(item.receiverThreadIds)} states=${JSON.stringify(item.agentsStates)}`
      if (item?.type === 'commandExecution')
        tag += ` ${JSON.stringify(item.command)} status=${String(item.status)}`
      if (item?.type === 'subAgentActivity')
        tag += ` kind=${String(item.kind)} agent=${String(item.agentThreadId)}`
      if (item?.type === 'agentMessage' && n.method === 'item/completed')
        tag += ` ${JSON.stringify(String(item.text ?? '').slice(0, 60))}`
      console.log(`${ms()} ${who.padEnd(13)} ${n.method}${tag}`)
      if (n.method === 'turn/started' && turn) {
        if (from === parent) parentTurn = String(turn.id)
        else childTurns.set(from, String(turn.id))
      }
      if (from && from !== parent && item?.type === 'commandExecution' && n.method === 'item/started')
        childCommandStarted = true
      if (from === parent && n.method === 'turn/completed') parentDone = true
      if (
        !acted &&
        (mode === 'interrupt' ? childCommandStarted && !parentDone : parentDone && childTurns.size > 0)
      )
        void act(client)
    },
    onRequest: (r) => console.log(`${ms()} request ${r.method}`),
    onExit: () => console.log(`${ms()} app-server exited`),
  })
  const started = await client.request<{ thread?: { id?: string } }>('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    model: process.env.PROBE_MODEL ?? 'gpt-5.6-luna',
    config: { model_reasoning_effort: 'low' },
  })
  parent = started.thread?.id ?? ''
  await client.request('turn/start', {
    threadId: parent,
    effort: 'low',
    input: [
      {
        type: 'text',
        text:
          'Use spawn_agent exactly once to start one child agent with this task: "Run the shell command `sleep 193; echo child-done`, ' +
          'then reply with exactly the word done." Do not wait for the child. Right after spawning it, run the shell command ' +
          '`sleep 25; echo parent-done` yourself, then reply to me with one word. Do nothing else.',
      },
    ],
  })
  const deadline = Date.now() + 160_000
  while (Date.now() < deadline && (stopAt === 0 || Date.now() < stopAt))
    await new Promise((r) => setTimeout(r, 250))
  console.log(`${ms()} -- after: childAlive=${childAlive()} parentDone=${parentDone}`)
  await client.request('thread/delete', { threadId: parent }).catch(() => {})
  await client.dispose()
  await new Promise((r) => setTimeout(r, 1500))
  console.log(`${ms()} -- after dispose: childAlive=${childAlive()}`)
  console.log(`frames: ${log}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pattern: RegExp) => pattern.test(execFileSync('ps', ['-axo', 'pid,command']).toString())
const threadParams = (cwd: string) => ({
  cwd,
  approvalPolicy: 'never',
  sandbox: 'workspace-write',
  model: process.env.PROBE_MODEL ?? 'gpt-5.6-luna',
  config: { model_reasoning_effort: 'low' },
})
/** Resolved by the next notification `pick` accepts, from the ones arriving after the call */
type Watch = { pick(n: ServerNotification): boolean; resolve(n: ServerNotification): void }

/** `--inventory shell`: does a `sleep` Codex keeps running outlive the turn, and the app-server? */
async function inventoryShell(): Promise<void> {
  const dir = probeDir('cc-codex-rest-')
  const t = () => String(Date.now() - dir.t0).padStart(6)
  const items = new Map<
    string,
    { command: string; status: string; exitCode: unknown; processId: unknown; source: unknown }
  >()
  let turnOpen = false
  const watches: Watch[] = []
  const { client } = await openProbe(dir, {
    onNotification: (n) => {
      const p = (n.params ?? {}) as Record<string, unknown>
      const item = p.item as Record<string, unknown> | undefined
      if (
        item?.type === 'commandExecution' &&
        (n.method === 'item/started' || n.method === 'item/completed')
      ) {
        items.set(String(item.id), {
          command: String(item.command),
          status: String(item.status),
          exitCode: item.exitCode,
          processId: item.processId,
          source: item.source,
        })
        console.log(
          `${t()} ${n.method} commandExecution ${JSON.stringify(item.command)} status=${String(item.status)} exitCode=${String(item.exitCode)} pid=${String(item.processId)} source=${String(item.source)} ${turnOpen ? 'in a turn' : 'OUTSIDE a turn'}`,
        )
      } else if (!n.method.endsWith('Delta') && !n.method.endsWith('/delta'))
        console.log(`${t()} ${n.method}`)
      if (n.method === 'turn/started') turnOpen = true
      if (n.method === 'turn/completed') turnOpen = false
      for (const w of [...watches]) if (w.pick(n)) (watches.splice(watches.indexOf(w), 1), w.resolve(n))
    },
    onExit: () => console.log(`${t()} app-server exited`),
  })
  const next = (pick: Watch['pick'], ms: number) =>
    Promise.race([
      new Promise<ServerNotification>((resolve) => watches.push({ pick, resolve })),
      sleep(ms).then(() => null),
    ])
  const thread =
    (await client.request<{ thread?: { id?: string } }>('thread/start', threadParams(dir.cwd))).thread?.id ??
    ''
  const startKept = async (seconds: number) => {
    const ended = next((n) => n.method === 'turn/completed', 180_000)
    await client.request('turn/start', {
      threadId: thread,
      effort: 'low',
      input: [
        {
          type: 'text',
          text:
            `Start the shell command \`sleep ${seconds}; echo kept-done\` so that it keeps running after your turn ends: run it with your ` +
            'command tool and the shortest wait for output it allows, and do not wait for it, poll it or stop it. Do not use `&`, `nohup` ' +
            'or `disown`. Then reply with the word started and end your turn.',
        },
      ],
    })
    if (!(await ended)) throw new Error('the turn did not end within 180 s')
    const open = [...items.values()].filter(
      (i) => i.command.includes(`sleep ${seconds}`) && i.status === 'inProgress',
    )
    const how =
      [...items.values()]
        .filter((i) => i.command.includes(`sleep ${seconds}`))
        .map((i) => `${i.source}/${i.status}`)
        .join(', ') || 'no such command item'
    console.log(
      `RESULT ${seconds}: command items at turn end: ${how}; inProgress at turn end: ${open.length}; sleep alive: ${alive(new RegExp(`sleep ${seconds}`))}`,
    )
    return open
  }

  // Turn 1: does the item end by itself after the turn, and with what
  const open1 = await startKept(23)
  if (open1.length > 0) {
    const done = await next(
      (n) =>
        n.method === 'item/completed' &&
        (n.params as { item?: { type?: string; command?: string } }).item?.command?.includes('sleep 23') ===
          true,
      45_000,
    )
    const item = (done?.params as { item?: Record<string, unknown> } | undefined)?.item
    console.log(
      `RESULT 23: item/completed after the turn: ${done ? `yes, status=${String(item?.status)} exitCode=${String(item?.exitCode)}` : 'no, within 45 s'}; sleep alive: ${alive(/sleep 23/)}`,
    )
  }

  // Turn 2: is the kept process ended with the app-server
  await startKept(197)
  await sleep(5_000)
  const before = alive(/sleep 197/)
  await client.dispose()
  await sleep(3_000)
  console.log(
    `RESULT 197: alive 5 s after the turn: ${before}; alive 3 s after the app-server closed: ${alive(/sleep 197/)}`,
  )
  console.log(`thread ${thread} (left in the CODEX_HOME's sessions); frames: ${dir.log}`)
}

/** `--inventory goal`: does an active goal start turns on a thread nobody sends to? */
async function inventoryGoal(): Promise<void> {
  const dir = probeDir('cc-codex-goal-')
  const t = () => String(Date.now() - dir.t0).padStart(6)
  let started = 0
  let completed = 0
  let goal = 'none'
  const { client } = await openProbe(dir, {
    onNotification: (n) => {
      const p = (n.params ?? {}) as Record<string, unknown>
      if (n.method === 'turn/started') started++
      if (n.method === 'turn/completed') completed++
      if (n.method === 'thread/goal/updated')
        goal = String((p.goal as { status?: string } | undefined)?.status)
      if (n.method === 'thread/goal/cleared') goal = 'cleared'
      if (!n.method.endsWith('Delta') && !n.method.endsWith('/delta'))
        console.log(
          `${t()} ${n.method}${n.method.startsWith('thread/goal') ? ` ${JSON.stringify(p.goal ?? null)}` : ''}`,
        )
    },
    onExit: () => console.log(`${t()} app-server exited`),
  })
  const thread =
    (await client.request<{ thread?: { id?: string } }>('thread/start', threadParams(dir.cwd))).thread?.id ??
    ''
  const set = await client.request<{ goal?: { status?: string } }>('thread/goal/set', {
    threadId: thread,
    objective:
      'Create a file named goal.txt in the current folder that holds the word ok. The goal is complete once that file exists.',
  })
  console.log(`${t()} thread/goal/set answered status=${String(set.goal?.status)}`)
  const until = Date.now() + 5 * 60_000
  while (Date.now() < until) await sleep(1_000)
  console.log(
    `RESULT goal: turns started without a turn/start: ${started}, completed: ${completed}; goal status at the end: ${goal}`,
  )
  await client.request('thread/goal/clear', { threadId: thread }).catch(() => {})
  await client.dispose()
  console.log(`thread ${thread} (left in the CODEX_HOME's sessions); frames: ${dir.log}`)
}
