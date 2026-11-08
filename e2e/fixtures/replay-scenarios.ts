import { expect, test, type Page } from '@playwright/test'
import { PermissionPreset, type ToolName } from '@cc/protocol'
import { recordedScenarios, recordingFile, REPLAYED } from '../../packages/agent-host/src/adapters/frames/replay-agent.test-helpers.js'
import { inFolder, loadRecording, type Recording } from '../../packages/agent-host/src/adapters/frames/replay.test-helpers.js'
import { scenariosFor } from '../../packages/agent-host/src/adapters/frames/scenarios.test-helpers.js'
import { ORCHESTRATOR_MCP_NAME } from '../../packages/agent-host/src/apps/contract.js'
import { openFolds } from './folds.js'
import { openSession, type ReplayHost, type ReplayRun, startReplayHost } from './replay-host.js'

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
  /** The tool calls, by the name the tool gave them; Centralu's own and an attached app's are drawn with a mark of their own, not their name */
  tools: { name: string; marked?: true }[]
  /** What the person picked on the cards that ask a question, in order: the labels of the options */
  answers: string[]
  /** The thoughts the tool showed the words of, where the tool shows any (Codex's reasoning summaries) */
  thoughts?: number
  /** The compactions the tool announced, with the size of the conversation before and after where it says */
  compactions: { before?: number; after?: number }[]
  /** What the tool said in the agent's place when a request failed (Claude's synthetic message with `error`): the error line's words, not a bubble */
  failure?: string
}

/** Whether the MCP server's calls are drawn with a mark of their own: Centralu's own tools and an attached app's */
const marked = (server: string): boolean => server === ORCHESTRATOR_MCP_NAME || server.startsWith('app-')

/** The tool's frames, read for `Held`; one per recorded tool */
const HELD: Record<string, (recording: Recording) => Held> = {
  claude: (recording) => {
    const held: Held = { steps: [], said: [], order: [], tools: [], answers: [], compactions: [] }
    let running = false
    let ended = false
    const say = (words: string) => {
      held.said.push(words)
      held.order.push('said')
    }
    const call = (name: string) => held.tools.push(marked(/^mcp__(.+?)__/.exec(name)?.[1] ?? '') ? { name, marked: true } : { name })
    /** The messages that streamed: their words and calls were taken as they came, and the whole message says them again */
    const streamed = new Set<string>()
    for (const f of recording.frames) {
      if (f.dir === 'exit') {
        ended = true
        continue
      }
      const m = f.msg as { type?: string; subtype?: string; error?: string; parent_tool_use_id?: string | null; message?: { id?: string; content?: { type: string; text?: string; name?: string }[] }; request?: { subtype?: string }; response?: { response?: { updatedInput?: { answers?: Record<string, string> } } }; event?: Record<string, any>; compact_metadata?: { pre_tokens: number; post_tokens: number } } | undefined
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
        else if (m.type === 'control_response') {
          // The answer to a question card: the option the person picked for each question
          const answers = (m.response?.response?.updatedInput?.answers ?? {})
          held.answers.push(...Object.values(answers))
        }
      } else if (f.dir === 'in') {
        if (m.type === 'result') running = false
        if (m.type === 'system' && m.subtype === 'compact_boundary') held.compactions.push({ before: m.compact_metadata!.pre_tokens, after: m.compact_metadata!.post_tokens })
        // A subagent's own words and calls are drawn inside its card, not in the conversation
        if (m.parent_tool_use_id) continue
        if (m.type === 'assistant' && m.error) held.failure = (m.message?.content ?? []).map((b) => b.text ?? '').join('')
        else if (m.type === 'assistant' && !streamed.has(String(m.message?.id))) {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text') say(b.text ?? '')
            else if (b.type === 'tool_use') call(String(b.name))
          }
        }
        if (m.type !== 'stream_event') continue
        const e = m.event
        if (e?.type === 'message_start') streamed.add(String(e.message?.id))
        else if (e?.type === 'content_block_start' && e.content_block?.type === 'text') say('')
        else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') held.said[held.said.length - 1] += String(e.delta.text)
        else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') call(String(e.content_block.name))
      }
    }
    return held
  },
  codex: (recording) => {
    const held: Held = { steps: [], said: [], order: [], tools: [], answers: [], compactions: [] }
    let running = false
    let ended = false
    /** Whether the agent has called Centralu's `compact_self`, after which a compaction is the host's, not the person's */
    let askedToCompact = false
    /** The block of words each message item is */
    const blocks = new Map<string, number>()
    /** The reasoning items that said something of what they thought */
    const thoughts = new Set<string>()
    for (const f of recording.frames) {
      if (f.dir === 'exit') {
        ended = true
        continue
      }
      const m = f.msg as { method?: string; params?: Record<string, any> } | undefined
      if (typeof m?.method !== 'string') continue
      const p = m.params ?? {}
      if (f.dir === 'out') {
        // A new process after the last one ended is the person restarting the agent
        if (m.method === 'initialize' && ended && held.steps.length > 0) held.steps.push({ kind: 'restart' })
        if (m.method === 'initialize') ended = false
        if (m.method === 'turn/start') {
          held.steps.push({ kind: 'prompt', text: (p.input as { text?: string }[]).map((i) => i.text ?? '').join(''), ...(running ? { during: true } : {}) })
          held.order.push('prompt')
          running = true
        } else if (m.method === 'thread/compact/start') {
          // The command the person typed is drawn as their words; after the agent's own `compact_self` the host asked for it, and nothing is typed
          if (!askedToCompact) {
            held.steps.push({ kind: 'prompt', text: '/compact' })
            held.order.push('prompt')
          }
          running = true
        } else if (m.method === 'turn/interrupt') held.steps.push({ kind: 'stop' })
        continue
      }
      const item = p.item as { type: string; id: string; text?: string; server?: string; tool?: string } | undefined
      if (m.method === 'turn/completed') running = false
      else if (m.method === 'item/started' && item?.type === 'agentMessage') {
        blocks.set(item.id, held.said.length)
        held.said.push('')
        held.order.push('said')
      } else if (m.method === 'item/agentMessage/delta') held.said[blocks.get(String(p.itemId))!] += String(p.delta)
      else if (m.method === 'item/reasoning/summaryTextDelta' && p.delta) thoughts.add(String(p.itemId))
      else if (m.method === 'item/completed' && item?.type === 'reasoning' && ((item as { summary?: string[] }).summary ?? []).some(Boolean)) thoughts.add(item.id)
      // The words the screen draws are the ones streamed; the whole message is the words of a message that was not streamed
      else if (m.method === 'item/completed' && item?.type === 'agentMessage' && held.said[blocks.get(item.id)!] === '') held.said[blocks.get(item.id)!] = item.text ?? ''
      else if (m.method === 'item/started' && item?.type === 'commandExecution') held.tools.push({ name: 'Bash' })
      else if (m.method === 'item/started' && item?.type === 'fileChange') held.tools.push({ name: 'Edit' })
      else if (m.method === 'item/started' && item?.type === 'mcpToolCall') {
        askedToCompact ||= item.tool === 'compact_self'
        held.tools.push(marked(String(item.server)) ? { name: String(item.tool), marked: true } : { name: String(item.tool) })
      }
      // Codex says how large the conversation was before and after in no frame
      else if (m.method === 'item/completed' && item?.type === 'contextCompaction') held.compactions.push({})
    }
    held.thoughts = thoughts.size
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
  /** What is on screen when the person presses Stop, where the recording holds one (not decided by the frames, which arrive at once): the activity "Thinking", or a line the turn's thoughts and calls are folded into */
  stopAt?: 'thinking' | 'folded'
  /** What this scenario draws that every recording does not */
  shows?(page: Page, held: Held, seen: Seen): Promise<void>
}

/** The words of `s` as a person reads them: the marks of Markdown (a heading's hashes, a bullet or a list's number, a code fence, a table's rule and bars, emphasis, a link's address) are not words */
const text = (s: string) =>
  s
    .replace(/^```.*$/gm, '')
    .replace(/^[\s:|-]*-{3,}[\s:|-]*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[|`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** "Context compacted here · 21.3k → 3.3k" where the tool says the sizes, else the plain line */
const compactionMark = (c: { before?: number; after?: number }): string => {
  const size = (n: number) => `${(n / 1000).toFixed(1)}k`
  return c.before !== undefined && c.after !== undefined ? `Context compacted here · ${size(c.before)} → ${size(c.after)}` : 'Earlier messages were compacted here'
}

/** How the polls wait: looked at again soon (a turn that has not ended is not looked at after a second), for as long as a replay on a loaded machine may take */
const POLL = { timeout: 15_000, intervals: [50, 100, 250] }

/** Stands for the mark of Centralu's own tools and an app's where the cards are listed: it is an icon, with no words */
const MARK = '<mark>'

const approvals = (page: Page) => page.getByTestId('msg-approval-log').allInnerTexts().then((rows) => rows.map(text))
const folds = (page: Page) => page.getByTestId('fold-line').allInnerTexts().then((rows) => rows.map(text))

/** The answers still to give: to the cards that ask to allow something, and to the ones that ask a question */
type Answers = { cards: Decision[]; picks: string[] }

async function settled(page: Page, answers: Answers): Promise<void> {
  const card = page.getByTestId('approval-card')
  const question = page.getByTestId('question-card')
  for (;;) {
    await expect.poll(async () => ((await card.count()) + (await question.count()) > 0 ? 'card' : (await page.getByTestId('activity-row').count()) === 0 ? 'idle' : 'busy'), POLL).not.toBe('busy')
    if ((await question.count()) > 0) {
      const pick = answers.picks.shift()
      if (!pick) throw new Error(`a card asked ${await question.innerText()} and the recording holds no answer to it`)
      // A single-choice question is answered by its option, with no Answer to press
      await question.getByTestId('question-option').filter({ hasText: pick }).first().click({ timeout: 10_000 })
      await expect(question).toHaveCount(0)
      continue
    }
    if ((await card.count()) === 0) return
    const decision = answers.cards.shift()
    if (!decision) throw new Error(`a card asked for ${await card.getByTestId('approval-detail').innerText()} and the entry has no answer for it`)
    await card.getByTestId(`approve-${decision}`).click({ timeout: 10_000 })
    await expect(card).toHaveCount(0)
  }
}

async function play(page: Page, replay: Replay, held: Held, run: ReplayRun): Promise<void> {
  const answers: Answers = { cards: [...(replay.cards ?? [])], picks: [...held.answers] }
  const input = page.getByTestId('prompt-input')
  for (const [i, step] of held.steps.entries()) {
    if (step.kind === 'stop') {
      const cue = {
        thinking: page.getByTestId('activity-label').filter({ hasText: 'Thinking' }),
        folded: page.getByTestId('tool-card-toggle').or(page.getByTestId('fold-line')),
      }[replay.stopAt ?? 'thinking']
      await expect(cue.first()).toBeVisible()
      await page.getByTestId('activity-interrupt').click({ timeout: 10_000 })
      await settled(page, answers)
      continue
    }
    if (step.kind === 'restart') {
      // The next prompt goes to the new process: it is there once the adapter has started another
      const started = run.starts()
      await page.getByTestId('restart-session').click()
      await expect.poll(() => run.starts(), POLL).toBe(started + 1)
      await expect(page.getByTestId('restart-spinning')).toHaveCount(0)
      continue
    }
    await input.fill(step.text)
    // A slash command is picked from the list the typing opens, then sent
    if (step.text.startsWith('/')) await input.press('Enter')
    await input.press('Enter')
    // A turn that is stopped does not end by itself, and one that has another prompt sent into it ends after that: the next step ends it
    const next = held.steps[i + 1]
    if (next?.kind !== 'stop' && !(next?.kind === 'prompt' && next.during)) await settled(page, answers)
  }
  expect(answers, 'every answer the entry and the recording hold was asked for').toEqual({ cards: [], picks: [] })
}

/** The pane against `held`: every recording gets these */
async function expectPane(page: Page, held: Held): Promise<Seen> {
  const seen: Seen = { folds: [] }
  // The person's bubbles and the agent's, each in its place: a block of words under the wrong prompt, or two blocks drawn as one, is a different list
  const prompts = held.steps.flatMap((s) => (s.kind === 'prompt' ? [s.text] : []))
  const words = [...held.said]
  const bubbles = held.order.map((kind) => (kind === 'prompt' ? prompts.shift()! : words.shift()!)).map(text).filter(Boolean)
  await expect.poll(async () => (await page.locator('[data-testid=msg-user] [data-mine-bubble], [data-testid=msg-assistant]').allInnerTexts()).map(text), POLL).toEqual(bubbles)
  // Thoughts and tool calls fold into one line a run (#2007, #2023): none is drawn until its line is opened, and the lines count them all
  const counted = (word: string) => async () => (await page.getByTestId('fold-summary').allInnerTexts()).reduce((n, t) => n + Number(new RegExp(`(\\d+) ${word}s?\\b`).exec(t)?.[1] ?? 0), 0)
  if (held.tools.length > 0) {
    await expect(page.getByTestId('tool-card')).toHaveCount(0)
    await expect.poll(counted('tool'), POLL).toBe(held.tools.length)
  }
  if (held.thoughts !== undefined) await expect.poll(counted('thought'), POLL).toBe(held.thoughts)
  seen.folds = await folds(page)
  if (held.tools.length > 0) await openFolds(page)
  // Each call is a card: its tool's name on a badge, or the mark of Centralu's own tools and an app's where the call is one of theirs
  const cards = page.locator('[data-testid=tool-card], [data-testid=ask-project-card]')
  await expect
    .poll(() => cards.evaluateAll((els, mark) => els.map((e) => (e.querySelector('[data-testid=centralu-call-mark]') ? mark : (e.querySelector('[data-testid=tool-card-toggle] > span:first-child')?.textContent ?? ''))), MARK), POLL)
    .toEqual(held.tools.map((t) => (t.marked ? MARK : t.name)))
  await expect(page.getByTestId('centralu-call-mark')).toHaveCount(held.tools.filter((t) => t.marked).length)
  await expect.poll(async () => (await page.getByTestId('msg-mark').filter({ hasText: /compacted/i }).allInnerTexts()).map(text), POLL).toEqual(held.compactions.map(compactionMark))
  return seen
}

/** One long answer is one bubble, its lines in order to the last */
const oneLongAnswer: Replay['shows'] = async (page) => {
  await expect(page.getByTestId('msg-assistant')).toHaveCount(1)
  expect(text(await page.getByTestId('msg-assistant').innerText())).toMatch(/^1 2 3 .* 149 150$/)
}

/** A turn the person stopped ends as stopped: no failure on the page, and the composer takes the next message */
const stopped: Replay['shows'] = async (page) => {
  await expect(page.getByTestId('msg-mark')).toHaveCount(0)
  await expect(page.getByTestId('activity-row')).toHaveCount(0)
}

/** The tool cards of the run, each opened (once: pressing an open one closes it) and read: its words and its result */
async function cardTexts(page: Page): Promise<string[]> {
  for (const toggle of await page.getByTestId('tool-card-toggle').all()) await toggle.click()
  return (await page.getByTestId('tool-card').allInnerTexts()).map(text)
}

/** The marks in the conversation that say a turn failed */
const failure = async (page: Page) => (await page.getByTestId('msg-mark').allInnerTexts()).map(text).filter((t) => t.startsWith('The agent could not finish this turn'))

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
    shows: oneLongAnswer,
  },
  { tool: 'claude', scenario: 'interrupt', shows: stopped },
  {
    tool: 'claude',
    scenario: 'interrupt-tool',
    stopAt: 'folded',
    async shows(page, held, seen) {
      // The call that was cut off is counted failed on its line; the turn itself ends as stopped, with no error line
      expect(seen.folds).toEqual(['1 tool 1 failed'])
      await stopped(page, held, seen)
    },
  },
  { tool: 'claude', scenario: 'compact' },
  {
    tool: 'claude',
    scenario: 'failed',
    async shows(page, held) {
      // The CLI's own message (a synthetic one, no model behind it) is the error line only: no bubble (`expectPane`), and the note under the composer points to the line (#2050)
      expect(text(await page.getByTestId('msg-mark').innerText())).toBe(`The agent could not finish this turn — ${text(held.failure!)}`)
      await expect(page.getByTestId('msg-assistant')).toHaveCount(0)
      await expect(page.getByTestId('error-note')).toBeVisible()
    },
  },
  { tool: 'claude', scenario: 'files' },
  { tool: 'claude', scenario: 'die' },
  { tool: 'claude', scenario: 'background' },
  { tool: 'claude', scenario: 'queued' },
  { tool: 'claude', scenario: 'resume' },
  { tool: 'claude', scenario: 'background-open' },
  { tool: 'claude', scenario: 'background-poll' },
  {
    tool: 'claude',
    scenario: 'centralu-agents',
    async shows(page) {
      // Each call is drawn as what it did, under the mark of Centralu's tools
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(["Searched past conversations","Read a session","Started an agent"])
    },
  },
  {
    tool: 'claude',
    scenario: 'centralu-compact',
    async shows(page) {
      // Each call is drawn as what it did, under the mark of Centralu's tools
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(["Asked to compact"])
    },
  },
  {
    tool: 'claude',
    scenario: 'centralu-mail',
    async shows(page) {
      // Each call is drawn as what it did, under the mark of Centralu's tools
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(["Mail","Mail"])
    },
  },
  { tool: 'claude', scenario: 'image' },
  { tool: 'claude', scenario: 'long-output' },
  {
    tool: 'claude',
    scenario: 'markdown',
    async shows(page, held) {
      // Each construct of the answer's Markdown is drawn as one: the heading, the bullets, the code block, the table's rows
      const markdown = held.said[0]!
      const count = (pattern: RegExp) => (markdown.match(pattern) ?? []).length
      const drawn = await page.getByTestId('msg-assistant').evaluate((el) => ({ headings: el.querySelectorAll('h1,h2,h3,h4,h5,h6').length, items: el.querySelectorAll('li').length, blocks: el.querySelectorAll('pre').length, rows: el.querySelectorAll('tr').length }))
      expect(drawn).toEqual({ headings: count(/^#{1,6} /gm), items: count(/^\s*[-*+] /gm), blocks: count(/^```/gm) / 2, rows: count(/^\|/gm) - 1 })
    },
  },
  {
    tool: 'claude',
    scenario: 'mcp-app',
    async shows(page) {
      // A tool of an attached app: marked as the app's, named by the app and its tool
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['weather: forecast'])
      await expect(page.getByTestId('centralu-call-mark')).toHaveAttribute('data-mark', 'app')
    },
  },
  {
    tool: 'claude',
    scenario: 'plan',
    cards: ['allow'],
    async shows(page) {
      // The plan is asked about as an approval of the tool's raw input, not as a plan to read (#2043)
      expect((await approvals(page))[0]).toMatch(/^Allowed · ExitPlanMode \{"plan":"# Plan/)
    },
  },
  { tool: 'claude', scenario: 'powershell' },
  {
    tool: 'claude',
    scenario: 'centralu-agent',
    // A recording made through a host: its tools were served by one, and the replay host stands in with tools that answer a success
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Started an agent'])
    },
  },
  {
    tool: 'claude',
    scenario: 'centralu-ask',
    // A recording made through a host: its tools were served by one, and the replay host stands in with tools that answer a success
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Asked frames-record-other'])
      expect(await page.getByTestId('ask-project-status').allInnerTexts()).toEqual(['answered'])
    },
  },
  {
    tool: 'claude',
    scenario: 'centralu-failed',
    // A recording made through a host: its tools were served by one, and the replay host stands in with tools that answer a success
    async shows(page, _held, seen) {
      // The call the host refused is counted failed on its line, and the turn goes on to say so
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Read a session'])
      expect(seen.folds).toEqual(['1 tool 1 failed'])
    },
  },
  {
    tool: 'claude',
    scenario: 'centralu-session',
    // A recording made through a host: its tools were served by one, and the replay host stands in with tools that answer a success
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Started an agent', 'Sent more to an agent'])
    },
  },
  { tool: 'claude', scenario: 'mcp-call' },
  { tool: 'claude', scenario: 'thinking' },
  { tool: 'claude', scenario: 'todo' },
  { tool: 'claude', scenario: 'web' },
  { tool: 'claude', scenario: 'question' },
  { tool: 'claude', scenario: 'subagent' },
  {
    tool: 'claude',
    scenario: 'tool-error',
    async shows(page, _held, seen) {
      // A command that exits with an error and a read of a file that is not there: both calls are counted failed, and the turn goes on to say so
      expect(seen.folds).toEqual(['2 tools 2 failed'])
      await expect(page.getByTestId('msg-mark')).toHaveCount(0)
    },
  },
  {
    tool: 'codex',
    scenario: 'basic',
    async shows(page, _held, seen) {
      // A file written under `auto` asks nothing: its thought and the one call are folded lines before the answer
      expect(seen.folds).toEqual(['1 thought', '1 tool'])
      expect(await approvals(page)).toEqual([])
    },
  },
  {
    tool: 'codex',
    scenario: 'approval',
    cards: ['allow', 'deny', 'always'],
    async shows(page, _held, seen) {
      expect(await approvals(page)).toEqual([expect.stringMatching(/^Allowed · .*touch probe-1\.txt'?$/), expect.stringMatching(/^Denied · .*touch probe-2\.txt'?$/), expect.stringMatching(/^Allowed · .*touch probe-3\.txt \.'?$/)])
      // Each turn's calls are one line; the denied one says it failed, and the fourth, run on the rule, asked nothing
      expect(seen.folds.map((f) => f.replace(/\d+ thoughts? · /, '')).filter((f) => f.includes('tool'))).toEqual(['1 tool', '1 tool 1 failed', '1 tool', '1 tool'])
    },
  },
  // A burst of one delta a line (#2059: it threw "Maximum update depth exceeded" in the page and left the turn busy under WebKit)
  { tool: 'codex', scenario: 'big-output', shows: oneLongAnswer },
  { tool: 'codex', scenario: 'interrupt', stopAt: 'folded', shows: stopped },
  { tool: 'codex', scenario: 'queued' },
  {
    tool: 'codex',
    scenario: 'failed',
    async shows(page) {
      const model = scenariosFor('codex').find((s) => s.name === 'failed')!.model!
      // The app-server's warning that it knows nothing of the model, then the refusal; the reason is under the composer too
      const marks = (await page.getByTestId('msg-mark').allInnerTexts()).map(text)
      expect(marks).toHaveLength(2)
      expect(marks[0]).toContain(`Model metadata for ${model} not found`)
      expect(marks[1]).toContain(`Codex refused the model ${model}`)
      await expect(page.getByTestId('error-note')).toBeVisible()
    },
  },
  {
    tool: 'codex',
    scenario: 'long-command',
    async shows(page, _held, seen) {
      expect(seen.folds).toEqual(['1 tool'])
      expect(await cardTexts(page)).toEqual([expect.stringContaining('long-done')])
    },
  },
  {
    tool: 'codex',
    scenario: 'command-failed',
    async shows(page, _held, seen) {
      // The command's own words, on a card the line counts as failed; the turn is not an error
      expect(seen.folds).toEqual(['1 tool 1 failed'])
      expect(await cardTexts(page)).toEqual([expect.stringContaining('No such file or directory')])
      expect(await failure(page)).toEqual([])
    },
  },
  {
    tool: 'codex',
    scenario: 'long-output',
    async shows(page) {
      // The card shows the start of an output of 3000 lines, not all of it
      const [card] = await cardTexts(page)
      expect(card).toMatch(/^Bash .*seq 1 3000' 1 2 3 4 5 .* 100 /)
      expect(card).not.toContain(' 2999 ')
    },
  },
  {
    tool: 'codex',
    scenario: 'mcp-call',
    async shows(page) {
      // A tool of the person's own MCP server: named by its server and tool, with its answer
      expect(await cardTexts(page)).toEqual([expect.stringMatching(/^ping probe: ping pong$/)])
    },
  },
  {
    tool: 'codex',
    scenario: 'files',
    async shows(page) {
      // A file created and one deleted are two cards of the same kind and path; nothing on the card says which is the delete (#2060)
      const cards = await cardTexts(page)
      expect(cards).toHaveLength(2)
      expect(cards.every((c) => c.includes('gone.txt'))).toBe(true)
    },
  },
  { tool: 'codex', scenario: 'compact' },
  {
    tool: 'codex',
    scenario: 'die',
    async shows(page) {
      // The app-server killed in the middle of a turn: one error line and the reason under the composer, not a finished turn
      expect(await failure(page)).toEqual([expect.stringContaining('codex app-server exited')])
      await expect(page.getByTestId('error-note')).toBeVisible()
    },
  },
  { tool: 'codex', scenario: 'resume' },
  { tool: 'codex', scenario: 'resume-interrupted', stopAt: 'folded', shows: stopped },
  {
    tool: 'codex',
    scenario: 'resume-failed',
    async shows(page) {
      // The thread opened again after the failure says nothing more of it: the one error stays the one
      expect(await failure(page)).toHaveLength(1)
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-read',
    async shows(page) {
      // Each call is drawn as what it did, with Centralu's mark: the sessions listed, then one read
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Listed sessions', 'Read a session'])
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-mail',
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Listed sessions', 'Mail', 'Mail'])
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-compact',
    async shows(page) {
      // Asked to compact a small conversation, the call says why nothing is compacted; no compaction mark is drawn (the common check)
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Asked to compact'])
      expect((await cardTexts(page))[0]).toContain('over 100k tokens')
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-agent-session',
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Started an agent', 'Sent more to an agent', 'Waited for an agent'])
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-agent-stop',
    async shows(page) {
      // A child still working is stopped, then deleted: three calls of Centralu's, each drawn as what it did
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Started an agent', 'Stopped an agent', 'Deleted an agent'])
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-ask-untrusted',
    async shows(page) {
      // Work for another project is refused while this one is not trusted: the card says it did not finish, and why
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Asked frames-record-other'])
      expect(await page.getByTestId('ask-project-status').allInnerTexts()).toEqual(['did not finish'])
      await expect(page.getByTestId('ask-project-card')).toContainText('Refused (untrusted_project)')
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-ask-project',
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Asked frames-record-other'])
      expect(await page.getByTestId('ask-project-status').allInnerTexts()).toEqual(['answered'])
    },
  },
  {
    tool: 'codex',
    scenario: 'centralu-agent',
    async shows(page) {
      expect(await page.getByTestId('centralu-call-label').allInnerTexts()).toEqual(['Started an agent'])
      // The new agent's job as the title, and its answer in the card
      await expect(page.getByTestId('tool-card-title')).toHaveText(`Reply with exactly: pong (codex, ${REPLAYED.find((r) => r.tool === 'codex')!.model})`)
      expect((await cardTexts(page))[0]).toContain('answered, as JSON: "pong"')
    },
  },
]

/** Recordings that no entry plays, and why */
const NOT_PLAYED: Record<string, string> = {
  'claude/interrupt-approval': 'the screen has no Stop while a card is open: the person answers the card, which the approval scenario plays',
  'claude/question-declined': 'the screen has no Stop while a question card is open: it is answered by an option or by words, which the question scenario plays',
  'codex/interrupt-approval': 'the screen has no Stop while a card is open: the person answers the card, which the approval scenario plays',
  'codex/adopt-running': 'it opens an app-server that a keeper kept running through a host swap, and a replay host starts its processes itself, with no keeper to hold one; the adapter replay test plays it',
  'codex/centralu-wake': 'the second turn is started by the host from a mail that another session answers with; the replay host has no other session to send it, and the words typed as a person would be drawn as theirs, not as a mail',
  'codex/centralu-compact-real': 'the host starts the compaction (thread/compact/start) after the agent calls Centralu\'s compact_self, and a replay host never serves that call (the bridge is the recording host\'s); playing it would mean typing /compact, which draws a bubble the real session never draws, and the host-started compaction would go unexercised',
  'codex/adopt-failed': 'the same: a kept app-server answering the new host thread/resume',
}

/** Every scenario a project is made for, in one host that the tests of a worker share */
const everyScenario = (): string[] => [...new Set(REPLAYED.flatMap((row) => recordedScenarios(row)))]

const replayTest = test.extend<object, { replayHost: ReplayHost }>({
  replayHost: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads which fixtures a function uses from its first parameter
    async ({}, use) => {
      const host = await startReplayHost(everyScenario())
      try {
        await use(host)
      } finally {
        await host.cleanup()
      }
    },
    { scope: 'worker', timeout: 60_000 },
  ],
})

export function replayTests(): void {
  test('every recording has an entry, or a reason why none is played', () => {
    const recorded = REPLAYED.flatMap((row) => recordedScenarios(row).map((name) => `${row.tool}/${name}`))
    const accounted = [...REPLAYS.map((r) => `${r.tool}/${r.scenario}`), ...Object.keys(NOT_PLAYED)]
    expect(recorded.filter((r) => !accounted.includes(r)), 'recordings with no entry in REPLAYS and no reason in NOT_PLAYED').toEqual([])
    expect(accounted.filter((a) => !recorded.includes(a)), 'entries and reasons of recordings that are not there').toEqual([])
  })

  for (const replay of REPLAYS) {
    replayTest(`${replay.tool} ${replay.scenario}: the pane shows what the recording holds`, async ({ page, replayHost: host }) => {
      test.setTimeout(120_000)
      const row = REPLAYED.find((r) => r.tool === replay.tool)!
      const recording = loadRecording(recordingFile(row, replay.scenario))
      const run = host.run()
      // The recording's `<cwd>` is the folder the session runs in, as the replay reads it
      const held = inFolder(HELD[replay.tool]!(recording), host.folder(replay.scenario))
      let sessionId: string | undefined
      try {
        // The conversation draws only the rows in sight: a tall page holds the whole of a recorded session
        await page.setViewportSize({ width: 1280, height: 3000 })
        await page.goto('/')
        // Under the preset it was recorded with, as the adapter's own replay test drives it
        const preset = PermissionPreset.safeParse(recording.header.preset)
        sessionId = await openSession(page, host, replay.scenario, replay.tool, preset.success ? preset.data : (scenariosFor(replay.tool).find((s) => s.name === replay.scenario)?.preset ?? 'normal'))
        await play(page, replay, held, run)
        const seen = await expectPane(page, held)
        await replay.shows?.(page, held, seen)
        // Every recorded frame was given to the adapter
        await expect.poll(() => run.toTheEnd(), POLL).toBe(true)
      } catch (err) {
        console.log(`--- host stderr ---
${run.stderr()}`)
        throw err
      } finally {
        // The host stays for the next test, so this one ends its own session, which ends the process
        if (sessionId) await run.end(sessionId).catch(() => undefined)
      }
      // The process has ended, so nothing it would say is still to come: the adapter sent nothing the recording does not hold
      expect(run.problems()).toEqual([])
    })
  }
}
