import { alwaysAllowKey, type NormalizedEvent, type PermissionPreset } from '@cc/protocol'
import type { AgentAdapter, SessionHandle } from '../contract.js'

/**
 * The scenarios an ACP recording is made of (docs/plans/acp-adapter.md §10.4). The same code drives the adapter against
 * the real CLI (`scripts/acp-record.mts`, which writes the recording) and against the recording (`replay.test.ts`), so a
 * replay sends exactly what the recorded run sent. Prompts are short: a recording spends the person's model calls.
 */

export type Driver = {
  readonly events: NormalizedEvent[]
  session(): SessionHandle
  /** The next event after the ones already waited for that `pick` accepts */
  waitFor(label: string, pick: (e: NormalizedEvent) => boolean): Promise<NormalizedEvent>
  /** Ends this process and opens the conversation again in a new one, as a host restart does */
  reopen(): Promise<void>
  /** Kills the agent process, as a crash would */
  kill(): void
}

export type Scenario = {
  name: string
  preset?: PermissionPreset
  /** Whether the tool must be made to ask for every command (OpenCode: through its config; a profile knows how) */
  asksForCommands?: boolean
  run(d: Driver): Promise<void>
}

const ended = (e: NormalizedEvent) => e.type === 'turn_complete' || e.type === 'error' || (e.type === 'state_change' && e.state === 'waiting_input')
const turn = async (d: Driver, text: string) => {
  d.session().send(text)
  return d.waitFor(`the end of the turn "${text.slice(0, 30)}"`, ended)
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'basic',
    async run(d) {
      await turn(d, 'Reply with exactly: hello')
      await turn(d, 'Create a file named probe.txt containing the word hi, using your tools. Then say done.')
    },
  },
  {
    name: 'approval',
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
      await answer('Run the shell command: echo probe-1 . Then say done.', 'allow')
      await answer('Run the shell command: echo probe-2 . Then say done.', 'deny')
      await answer('Run exactly this shell command: echo probe-3 . Then say done.', 'always')
      await turn(d, 'Run exactly this shell command again: echo probe-3 . Then say done.')
    },
  },
  {
    name: 'interrupt',
    async run(d) {
      d.session().send('Count from 1 to 300, one number per line.')
      await d.waitFor('the first output', (e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
      await turn(d, 'Say ok.')
    },
  },
  {
    name: 'interrupt-approval',
    asksForCommands: true,
    async run(d) {
      d.session().send('Run the shell command: echo probe-x . Then say done.')
      await d.waitFor('an approval card', (e) => e.type === 'approval_request')
      d.session().interrupt()
      await d.waitFor('the stop', (e) => e.type === 'state_change' && e.state === 'waiting_input')
    },
  },
  {
    name: 'queued',
    async run(d) {
      const first = d.session().sendTracked!('Write a two-sentence story about a lighthouse.')
      const second = d.session().sendTracked!('What is 2+2? Answer in one word.')
      await Promise.all([first, second])
    },
  },
  {
    name: 'die',
    async run(d) {
      d.session().send('Write a 300-word essay on tides.')
      await d.waitFor('the first output', (e) => e.type === 'message_delta' || e.type === 'reasoning_delta')
      d.kill()
      await d.waitFor('the crash', (e) => e.type === 'error')
    },
  },
  {
    name: 'resume',
    async run(d) {
      await turn(d, 'Remember the code word: pelican. Reply with exactly: noted')
      await d.reopen()
      await turn(d, 'What was the code word? Answer with the word only.')
    },
  },
  {
    name: 'compact',
    async run(d) {
      await turn(d, 'Reply with exactly: one')
      await turn(d, '/compact')
      await turn(d, 'What did I ask you to reply with first? One word.')
    },
  },
]

/** Drives `adapter` through one scenario; `bound` is how long a step may wait (the real CLI) */
export async function drive(adapter: AgentAdapter, scenario: Scenario, cwd: string, sessionId: string, bound: number, killer: () => void): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = []
  let seen = 0
  const emit = (e: NormalizedEvent) => {
    events.push(e)
  }
  const opts = { sessionId, cwd, permissionPreset: scenario.preset ?? ('normal' as const), projectTrusted: true }
  let handle = await adapter.createSession(opts, emit)
  const driver: Driver = {
    events,
    session: () => handle,
    waitFor: (label, pick) =>
      new Promise((resolve, reject) => {
        const started = Date.now()
        const look = () => {
          while (seen < events.length) {
            const e = events[seen++]!
            if (pick(e)) return resolve(e)
          }
          if (Date.now() - started > bound) return reject(new Error(`${scenario.name}: no ${label} within ${bound} ms`))
          setTimeout(look, 5)
        }
        look()
      }),
    reopen: async () => {
      const externalId = handle.externalId ?? undefined
      await handle.dispose()
      handle = await adapter.createSession({ ...opts, resumeExternalId: externalId }, emit)
    },
    kill: killer,
  }
  await scenario.run(driver)
  await handle.dispose()
  return events
}
