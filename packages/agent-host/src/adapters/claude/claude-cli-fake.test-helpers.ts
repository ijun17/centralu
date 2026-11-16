import type { AgentAdapter } from '../contract.js'

/**
 * Claude Code's side of the wire, for a test that runs the real `ClaudeAdapter` in a real host (#2318 review): the factory of
 * `vi.mock('@anthropic-ai/claude-agent-sdk', …)`, spread over the module's own exports (`importOriginal`). It imports
 * nothing of the SDK, so the mock can load it. What it does is what Claude Code 2.1.296 was measured to do (raw CLI, stream-json, haiku):
 *
 *   - a process says its `init` only once it read its first input, so the adapter tracks no input before it (`tracksInputs`), and again
 *     at every turn it begins
 *   - a turn an input begins names it on its first frame (`user_message_uuid`) and in its result (`user_message_uuids`)
 *   - a background task that ended while the session rested makes the CLI run a turn of its own for the notification, which names no input,
 *     before the turn of the input that came with it (`notifyNext`)
 *   - quiet input (`shouldQuery: false`) is answered by a result naming it, with no turn
 *
 * An input whose words hold "long job", or an update's Continue, starts a turn that ends at `finish`; any other is answered at once. Not modelled:
 * a Stop's `cancel_queued` (an interrupt ends the open turn and cancels nothing queued), tool rounds, and inputs folded into a running turn
 */
type Frame = Record<string, unknown>
type Input = { uuid: string; text: string }
type Prompt = AsyncIterable<{ uuid?: unknown; shouldQuery?: unknown; message?: { content?: unknown } }>

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('') : ''
/** The words of the input itself, not the mailbox's frame around delivered mail */
const wordsOf = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
const longTurn = (words: string) => words.includes('long job') || words.includes('Continue where you stopped')

const result = (uuids: readonly string[]): Frame => ({
  type: 'result', subtype: 'success', is_error: false, result: '', user_message_uuids: uuids,
  modelUsage: { claude: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, total_cost_usd: 0,
})

class FakeClaudeProcess {
  /** The words of each input a turn ran for, in order */
  readonly ran: string[] = []
  /** The inputs of the open turn that waits for `finish` */
  long: Input[] | null = null
  private readonly read: Input[] = []
  private busy = false
  private readonly inbox: Frame[] = []
  private wake: (() => void) | null = null
  private closed = false
  private n = 0

  constructor(
    private readonly cli: FakeClaudeCli,
    private readonly conversation: string,
  ) {}

  start(prompt: Prompt) {
    void (async () => {
      for await (const u of prompt) this.input(String(u.uuid), wordsOf(textOf(u.message?.content)), u.shouldQuery === false)
    })().catch(() => {})
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Frame>> => {
          while (this.inbox.length === 0 && !this.closed) await new Promise<void>((r) => (this.wake = r))
          const value = this.inbox.shift()
          return value ? { value, done: false } : { value: undefined, done: true }
        },
      }),
      interrupt: async () => {
        if (this.long) this.end(this.long, null)
      },
      close: () => {
        this.closed = true
        this.long = null
        this.wake?.()
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  }

  finish(words: string): void {
    if (this.long) this.end(this.long, words)
  }

  private say(...frames: Frame[]): void {
    if (this.closed) return
    this.inbox.push(...frames)
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  private init(): Frame {
    return { type: 'system', subtype: 'init', session_id: this.conversation, claude_code_version: '2.1.296', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'], slash_commands: [] }
  }

  private assistant(words: string, uuid?: string): Frame {
    return { type: 'assistant', ...(uuid ? { user_message_uuid: uuid } : {}), message: { id: `${this.conversation}-m${++this.n}`, role: 'assistant', content: [{ type: 'text', text: words }] } }
  }

  private input(uuid: string, text: string, quiet: boolean): void {
    setTimeout(() => {
      if (quiet) return this.say(result([uuid]))
      this.read.push({ uuid, text })
      this.next()
    }, 5)
  }

  private next(): void {
    if (this.busy || this.read.length === 0) return
    this.busy = true
    const notified = this.cli.takeNotify()
    if (!notified) return this.turn(this.read.shift()!)
    void notified.until.then(() => {
      // The notification's turn: no input begins it, and its result names none
      this.say(this.init(), this.assistant('The background command finished.'), result([]))
      // The CLI lost the input: no turn runs it
      if (notified.how === 'drop') {
        this.ran.push(this.read.shift()!.text)
        this.busy = false
        return
      }
      // A moment later, as the CLI reads the next input after its own turn
      setTimeout(() => this.turn(this.read.shift()!), 20)
    })
  }

  private turn(input: Input): void {
    this.say(this.init(), this.assistant('working on it', input.uuid))
    this.ran.push(input.text)
    if (longTurn(input.text)) {
      this.long = [input]
      return
    }
    this.end([input], `echo: ${input.text.trim()}`)
  }

  /** `words`: what the turn says last; null: it was stopped */
  private end(inputs: Input[], words: string | null): void {
    this.long = null
    if (words !== null) this.say(this.assistant(words))
    this.say(words === null ? { ...result(inputs.map((i) => i.uuid)), subtype: 'error_during_execution', is_error: true } : result(inputs.map((i) => i.uuid)))
    this.busy = false
    setTimeout(() => this.next(), 5)
  }
}

/** The CLI of every process a test's real `ClaudeAdapter` starts (`claudeCli`) */
export class FakeClaudeCli {
  readonly processes: FakeClaudeProcess[] = []
  private notify: { how: true | 'drop'; until: Promise<void> } | null = null
  private conversations = 0

  /** The module `vi.mock` gives for `@anthropic-ai/claude-agent-sdk` */
  sdk() {
    return {
      query: ({ prompt, options }: { prompt: Prompt; options?: { resume?: unknown } }) => {
        const p = new FakeClaudeProcess(this, typeof options?.resume === 'string' ? options.resume : `conversation-${++this.conversations}`)
        this.processes.push(p)
        return p.start(prompt)
      },
    }
  }

  /**
   * A background task of the session ended while it rested: its notification's turn runs before the next input's; `'drop'`: and that input never
   * runs. `until`: that turn waits for it, so a test acts while the input waits
   */
  notifyNext(how: true | 'drop' = true, until: Promise<void> = Promise.resolve()): void {
    this.notify = { how, until }
  }

  takeNotify(): { how: true | 'drop'; until: Promise<void> } | null {
    const notified = this.notify
    this.notify = null
    return notified
  }

  /** Whether a turn ran for an input holding `words` (a dropped one counts: the CLI read it) */
  ran(words: string): boolean {
    return this.processes.some((p) => p.ran.some((t) => t.includes(words)))
  }

  /** Ends the one turn that waits for its end, saying `words` */
  finish(words: string): void {
    const open = this.processes.filter((p) => p.long)
    if (open.length !== 1) throw new Error(`${open.length} turns wait for their end`)
    open[0]!.finish(words)
  }

  reset(): void {
    this.processes.length = 0
    this.notify = null
  }
}

export const claudeCli = new FakeClaudeCli()

/** A real `ClaudeAdapter` over the fake CLI, with nothing read from the machine's own Claude Code: no conversation list, no history, installed */
export function offlineClaude(a: AgentAdapter): AgentAdapter {
  a.listExternalSessions = undefined
  a.readExternalHistory = undefined
  a.detect = async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'fake CLI' })
  return a
}
