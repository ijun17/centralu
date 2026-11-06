import { expect, test, type Page } from '@playwright/test'
import { PermissionPreset, type ToolName } from '@cc/protocol'
import { recordedScenarios, recordingFile, REPLAYED } from '../../packages/agent-host/src/adapters/frames/replay-agent.test-helpers.js'
import { inFolder, loadRecording, type Recording } from '../../packages/agent-host/src/adapters/frames/replay.test-helpers.js'
import { scenariosFor } from '../../packages/agent-host/src/adapters/frames/scenarios.test-helpers.js'
import { openFolds } from './folds.js'
import { openSession, type ReplayHost, replayedToTheEnd, replayProblems, replayStarts, startReplayHost } from './replay-host.js'

/**
 * The UI against what the tools really sent (#1498, step 2): each entry of `REPLAYS` is a recording played through the
 * real adapter on a real host (`replay-agent.test-helpers.ts`) and drawn by the real web UI. The person's part is read from
 * the recording: the prompts it holds are typed in the order it holds them, a Stop is pressed where it holds one. What
 * the pane must show is read from it too (`HELD`): the words, the tool calls, the compactions. So a re-recording changes
 * what is checked without a change here, and an entry adds nothing but what the recording cannot say (how a card was
 * answered, what was on screen when the person stopped), unless the scenario draws something of its own (`shows`).
 */

type Decision = 'allow' | 'deny' | 'always'

/** What the pane is to hold when the recording has been played, as the recording says */
export type Held = {
  /** What the person did, in order. A prompt `during` another's turn is sent while that turn runs */
  steps: ({ kind: 'prompt'; text: string; during?: boolean } | { kind: 'stop' } | { kind: 'restart' })[]
  /** The agent's words, one entry a block of text */
  said: string[]
  /** The conversation's bubbles in the order the tool made them: the person's prompts and the agent's blocks of text */
  order: ('prompt' | 'said')[]
  /** The tool calls, by the name the tool gave them */
  tools: string[]
  /** The compactions the tool announced, with the size of the conversation before and after */
  compactions: { before: number; after: number }[]
}

/** The tool's frames, read for `Held`; one per recorded tool */
const HELD: Record<string, (recording: Recording) => Held> = {
  claude: (recording) => {
    const held: Held = { steps: [], said: [], order: [], tools: [], compactions: [] }
    let running = false
    let ended = false
    const say = (words: string) => {
      held.said.push(words)
      held.order.push('said')
    }
    /** The messages that streamed: their words and calls were taken as they came, and the whole message says them again */
    const streamed = new Set<string>()
    for (const f of recording.frames) {
      if (f.dir === 'exit') {
        ended = true
        continue
      }
      const m = f.msg as { type?: string; subtype?: string; parent_tool_use_id?: string | null; message?: { id?: string; content?: { type: string; text?: string; name?: string }[] }; request?: { subtype?: string }; event?: Record<string, any>; compact_metadata?: { pre_tokens: number; post_tokens: number } } | undefined
      if (!m) continue
      if (f.dir === 'out') {
        if (m.type === 'user') {
          // A new process after the last one ended is the person restarting the agent
          if (ended && held.steps.length > 0) held.steps.push({ kind: 'restart' })
          ended = false
          held.steps.push({ kind: 'prompt', text: (m.message?.content ?? []).map((b) => b.text ?? '').join(''), ...(running ? { during: true } : {}) })
          held.order.push('prompt')
          running = true
        } else if (m.type === 'control_request' && m.request?.subtype === 'interrupt') held.steps.push({ kind: 'stop' })
      } else if (f.dir === 'in') {
        if (m.type === 'result') running = false
        if (m.type === 'system' && m.subtype === 'compact_boundary') held.compactions.push({ before: m.compact_metadata!.pre_tokens, after: m.compact_metadata!.post_tokens })
        // A subagent's own words and calls are drawn inside its card, not in the conversation
        if (m.parent_tool_use_id) continue
        if (m.type === 'assistant' && !streamed.has(String(m.message?.id))) {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text') say(b.text ?? '')
            else if (b.type === 'tool_use') held.tools.push(String(b.name))
          }
        }
        if (m.type !== 'stream_event') continue
        const e = m.event
        if (e?.type === 'message_start') streamed.add(String(e.message?.id))
        else if (e?.type === 'content_block_start' && e.content_block?.type === 'text') say('')
        else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') held.said[held.said.length - 1] += String(e.delta.text)
        else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') held.tools.push(String(e.content_block.name))
      }
    }
    return held
  },
}

/** What the pane showed before the checks opened anything */
export type Seen = { folds: string[] }

export type Replay = {
  tool: ToolName
  /** The scenario's file under the tool's newest recorded version */
  scenario: string
  /** How the person answers the cards, in the order they come: a recording says that a command was allowed, not that a card asked */
  cards?: Decision[]
  /** What is on screen when the person presses Stop, where the recording holds one: not decided by the frames, which arrive at once */
  stopAt?: 'thinking' | 'tool'
  /** What this scenario draws that every recording does not */
  shows?(page: Page, held: Held, seen: Seen): Promise<void>
}

const text = (s: string) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim()

const approvals = (page: Page) => page.getByTestId('msg-approval-log').allInnerTexts().then((rows) => rows.map(text))
const folds = (page: Page) => page.getByTestId('fold-line').allInnerTexts().then((rows) => rows.map(text))

async function settled(page: Page, cards: Decision[]): Promise<void> {
  const card = page.getByTestId('approval-card')
  for (;;) {
    await expect.poll(async () => ((await card.count()) > 0 ? 'card' : (await page.getByTestId('activity-row').count()) === 0 ? 'idle' : 'busy')).not.toBe('busy')
    if ((await card.count()) === 0) return
    const decision = cards.shift()
    if (!decision) throw new Error(`a card asked for ${await card.getByTestId('approval-detail').innerText()} and the entry has no answer for it`)
    await card.getByTestId(`approve-${decision}`).click({ timeout: 10_000 })
    await expect(card).toHaveCount(0)
  }
}

async function play(page: Page, replay: Replay, held: Held, host: ReplayHost): Promise<void> {
  const cards = [...(replay.cards ?? [])]
  const input = page.getByTestId('prompt-input')
  for (const [i, step] of held.steps.entries()) {
    if (step.kind === 'stop') {
      const cue = { thinking: page.getByTestId('activity-label').filter({ hasText: 'Thinking' }), tool: page.getByTestId('tool-card-toggle').or(page.getByTestId('fold-line')) }[replay.stopAt ?? 'thinking']
      await expect(cue.first()).toBeVisible()
      await page.getByTestId('activity-interrupt').click({ timeout: 10_000 })
      await settled(page, cards)
      continue
    }
    if (step.kind === 'restart') {
      // The next prompt goes to the new process: it is there once the adapter has started another
      const started = replayStarts(host.host)
      await page.getByTestId('restart-session').click()
      await expect.poll(() => replayStarts(host.host)).toBe(started + 1)
      await expect(page.getByTestId('restart-spinning')).toHaveCount(0)
      continue
    }
    await input.fill(step.text)
    // A slash command is picked from the list the typing opens, then sent
    if (step.text.startsWith('/')) await input.press('Enter')
    await input.press('Enter')
    // A turn that is stopped does not end by itself, and one that has another prompt sent into it ends after that: the next step ends it
    const next = held.steps[i + 1]
    if (next?.kind !== 'stop' && !(next?.kind === 'prompt' && next.during)) await settled(page, cards)
  }
  expect(cards, 'every answer the entry holds was asked for').toEqual([])
}

/** The pane against `held`: every recording gets these */
async function expectPane(page: Page, held: Held): Promise<Seen> {
  const seen: Seen = { folds: [] }
  // The person's bubbles and the agent's, each in its place: a block of words under the wrong prompt, or two blocks drawn as one, is a different list
  const prompts = held.steps.flatMap((s) => (s.kind === 'prompt' ? [s.text] : []))
  const words = [...held.said]
  const bubbles = held.order.map((kind) => (kind === 'prompt' ? prompts.shift()! : words.shift()!)).map(text).filter(Boolean)
  await expect.poll(async () => (await page.locator('[data-testid=msg-user] [data-mine-bubble], [data-testid=msg-assistant]').allInnerTexts()).map(text)).toEqual(bubbles)
  if (held.tools.length > 0) {
    // Tool calls fold into one line a run (#2023): none is drawn until its line is opened, and the lines count them all
    await expect(page.getByTestId('tool-card')).toHaveCount(0)
    await expect.poll(async () => (await page.getByTestId('fold-summary').allInnerTexts()).reduce((n, t) => n + Number(/(\d+) tools?/.exec(t)?.[1] ?? 0), 0)).toBe(held.tools.length)
    seen.folds = await folds(page)
    await openFolds(page)
  }
  const own = held.tools.filter((t) => !t.startsWith('mcp__centralu__'))
  const badges = page.locator('[data-testid=tool-card-toggle] > span:first-child')
  await expect.poll(() => badges.evaluateAll((els) => els.map((e) => e.textContent))).toEqual(own)
  // No recording holds a Centralu call yet, so this is 0 until one does; then it counts them
  await expect(page.getByTestId('centralu-call-mark')).toHaveCount(held.tools.length - own.length)
  // "Context compacted here · 21.3k → 3.3k"
  const size = (n: number) => `${(n / 1000).toFixed(1)}k`
  await expect.poll(async () => (await page.getByTestId('msg-mark').filter({ hasText: /compacted/i }).allInnerTexts()).map(text)).toEqual(held.compactions.map((c) => `Context compacted here · ${size(c.before)} → ${size(c.after)}`))
  return seen
}

export const REPLAYS: Replay[] = [
  {
    tool: 'claude',
    scenario: 'basic',
    async shows(page, _held, seen) {
      // A file written inside the folder under `edits` asks nothing: the call is one folded line before the answer
      expect(seen.folds).toEqual(['1 tool'])
      expect(await approvals(page)).toEqual([])
    },
  },
  {
    tool: 'claude',
    scenario: 'tools',
    cards: ['allow'],
    async shows(page, _held, seen) {
      // The read and the edit inside the folder are not asked; the command is, once
      expect(await approvals(page)).toEqual(['Allowed · touch tools-done.txt'])
      expect(seen.folds).toEqual(['3 tools'])
    },
  },
  {
    tool: 'claude',
    scenario: 'approval',
    cards: ['allow', 'deny', 'always'],
    async shows(page, _held, seen) {
      expect(await approvals(page)).toEqual(['Allowed · touch probe-1.txt', 'Denied · touch probe-2.txt', 'Allowed · touch probe-3.txt'])
      // Each turn's calls are one line between the question and the answer; the denied one says it failed, and the fourth, run on the rule, asked nothing
      expect(seen.folds).toEqual(['1 tool', '1 tool 1 failed', '1 tool', '1 tool'])
    },
  },
  {
    tool: 'claude',
    scenario: 'big-output',
    async shows(page) {
      // One long answer is one bubble, its lines in order to the last
      await expect(page.getByTestId('msg-assistant')).toHaveCount(1)
      expect(text(await page.getByTestId('msg-assistant').innerText())).toMatch(/^1 2 3 .* 149 150$/)
    },
  },
  {
    tool: 'claude',
    scenario: 'interrupt',
    async shows(page) {
      // A turn the person stopped ends as stopped: no failure on the page, and the composer takes the next message
      await expect(page.getByTestId('msg-mark')).toHaveCount(0)
      await expect(page.getByTestId('activity-row')).toHaveCount(0)
    },
  },
  {
    tool: 'claude',
    scenario: 'interrupt-tool',
    stopAt: 'tool',
    async shows(page, _held, seen) {
      // The call that was cut off is counted failed on its line; the turn itself ends as stopped, with no error line
      expect(seen.folds).toEqual(['1 tool 1 failed'])
      await expect(page.getByTestId('msg-mark')).toHaveCount(0)
      await expect(page.getByTestId('activity-row')).toHaveCount(0)
    },
  },
  { tool: 'claude', scenario: 'compact' },
  {
    tool: 'claude',
    scenario: 'failed',
    async shows(page, held) {
      // The CLI's own message (a synthetic one, no model behind it) is drawn as a bubble, as the error line in the conversation and as the reason under the composer
      expect(text(await page.getByTestId('msg-mark').innerText())).toBe(`The agent could not finish this turn — ${text(held.said[0]!)}`)
      await expect(page.getByTestId('error-note')).toBeVisible()
    },
  },
  { tool: 'claude', scenario: 'files' },
  { tool: 'claude', scenario: 'die' },
  { tool: 'claude', scenario: 'background' },
  { tool: 'claude', scenario: 'queued' },
  { tool: 'claude', scenario: 'resume' },
]

/** Recordings that no entry plays, and why */
const NOT_PLAYED: Record<string, string> = {
  'claude/interrupt-approval': 'the screen has no Stop while a card is open: the person answers the card, which the approval scenario plays',
}

export function replayTests(): void {
  test('every recording has an entry, or a reason why none is played', () => {
    const recorded = REPLAYED.flatMap((row) => recordedScenarios(row).map((name) => `${row.tool}/${name}`))
    const accounted = [...REPLAYS.map((r) => `${r.tool}/${r.scenario}`), ...Object.keys(NOT_PLAYED)]
    expect(recorded.filter((r) => !accounted.includes(r)), 'recordings with no entry in REPLAYS and no reason in NOT_PLAYED').toEqual([])
    expect(accounted.filter((a) => !recorded.includes(a)), 'entries and reasons of recordings that are not there').toEqual([])
  })

  for (const replay of REPLAYS) {
    test(`${replay.tool} ${replay.scenario}: the pane shows what the recording holds`, async ({ page }) => {
      test.setTimeout(120_000)
      const row = REPLAYED.find((r) => r.tool === replay.tool)!
      const recording = loadRecording(recordingFile(row, replay.scenario))
      const host = await startReplayHost([replay.scenario])
      // The recording's `<cwd>` is the folder the session runs in, as the replay reads it
      const held = inFolder(HELD[replay.tool]!(recording), host.folder(replay.scenario))
      try {
        // The conversation draws only the rows in sight: a tall page holds the whole of a recorded session
        await page.setViewportSize({ width: 1280, height: 3000 })
        await page.goto('/')
        // Under the preset it was recorded with, as the adapter's own replay test drives it
        const preset = PermissionPreset.safeParse(recording.header.preset)
        await openSession(page, host, replay.scenario, replay.tool, preset.success ? preset.data : (scenariosFor(replay.tool).find((s) => s.name === replay.scenario)?.preset ?? 'normal'))
        await play(page, replay, held, host)
        const seen = await expectPane(page, held)
        await replay.shows?.(page, held, seen)
        // Every recorded frame was given to the adapter
        await expect.poll(() => replayedToTheEnd(host.host)).toBe(true)
      } catch (err) {
        console.log(`--- host stderr ---\n${host.host.stderr()}`)
        throw err
      } finally {
        await host.cleanup()
      }
      // The host has stopped, so nothing it would say is still to come: the adapter sent nothing the recording does not hold
      expect(replayProblems(host.host)).toEqual([])
    })
  }
}
