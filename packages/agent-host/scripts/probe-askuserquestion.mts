/**
 * A probe measuring **how AskUserQuestion is actually received, and how an answer can reach the model**.
 *
 * In the orchestrator window, this tool leaked through as raw JSON with no choice UI, and the
 * tool came back as "the user did not answer." Before fixing it, the first question was how many
 * paths there are (2026-08-18):
 *
 *   (a) does it come through canUseTool           → yes: the arguments (question, choices) arrive whole
 *   (b) does it come through onUserDialog          → no: never called, whatever dialog kind is declared
 *   (c) does it just run to completion             → with the input unchanged, as "the user did not answer"
 *
 * The second question is what canUseTool can answer with. Each `--mode` is one answer, for the
 * question "Pick a color" answered "Blue":
 *
 *   A  allow, input unchanged
 *   B  allow, input unchanged, with `onUserDialog` and `supportedDialogKinds` declared
 *   C  deny, the answers as its message (`{"answers":[{"question":…,"answers":["Blue"]}]}`, what the
 *      adapter sent before #241)
 *   D  allow, `updatedInput.answers = { [question]: "Blue" }` (the SDK's own field, "User answers
 *      collected by the permission component" in sdk-tools.d.ts)
 *
 * Measured 2026-09-30 with SDK 0.3.263 and 0.3.285, model haiku; both versions gave the same results:
 *
 *   A  canUseTool saw it; is_error=false, "The user did not answer the questions."; the model said NONE
 *   B  onUserDialog called 0 times; otherwise the same as A
 *   C  is_error=true, the content is the answers JSON; the model answered Blue
 *   D  is_error=false, `Your questions have been answered: "Pick a color"="Blue". …`; the model answered Blue
 *
 * C reaches the model, but the CLI marks a denied tool's result as an error, so every answered card
 * read "Failed". D reaches the model as a success, and is what #241 adopted (`answerQuestion` in
 * adapters/claude/index.ts).
 *
 * Run with: node --import tsx packages/agent-host/scripts/probe-askuserquestion.mts [--mode A|B|C|D|all] [--model haiku]
 * It calls a live model once per mode. It works in a fresh temporary folder and writes nothing else.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Mode = 'A' | 'B' | 'C' | 'D'

const MODES: Record<Mode, string> = {
  A: 'allow, input unchanged',
  B: 'allow, input unchanged, onUserDialog declared',
  C: 'deny, the answers as its message',
  D: 'allow, updatedInput.answers',
}

const QUESTION = 'Pick a color'
const ANSWER = 'Blue'

const PROMPT =
  `Use the AskUserQuestion tool right now to ask me one question: "${QUESTION}", with two options, "Red" and "${ANSWER}". ` +
  'After the tool returns, reply with only the color I picked, or with NONE if the tool did not tell you my answer.'

/** The value after `--name`, or `--name=value` */
function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

function modesToRun(): Mode[] {
  const raw = (flag('mode') ?? 'all').toUpperCase()
  if (raw === 'ALL') return ['A', 'B', 'C', 'D']
  if (Object.hasOwn(MODES, raw)) return [raw as Mode]
  console.error(`Unknown --mode "${raw}". Use A, B, C, D or all.`)
  process.exit(2)
}

const MODEL = flag('model') ?? 'haiku'

type Outcome = {
  mode: Mode
  toolsSeen: string[]
  /** What AskUserQuestion was called with, as canUseTool saw it */
  input: unknown
  dialogs: string[]
  isError: boolean | null
  content: string
  reply: string
}

/** A tool result's content as text: a string as is, text blocks joined, anything else as JSON */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: unknown; text?: unknown }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(c)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}

/** The question texts in AskUserQuestion's input, each answered ANSWER */
function questionsIn(input: Record<string, unknown>): string[] {
  const qs = Array.isArray(input.questions) ? input.questions : []
  const texts = qs.map((q) => (q as { question?: unknown }).question).filter((t): t is string => typeof t === 'string')
  return texts.length > 0 ? texts : [QUESTION]
}

async function run(mode: Mode): Promise<Outcome> {
  const out: Outcome = { mode, toolsSeen: [], input: null, dialogs: [], isError: null, content: '', reply: '' }
  let askId: string | null = null
  let lastText = ''

  const opts: Record<string, unknown> = {
    cwd: mkdtempSync(join(tmpdir(), `cc-auq-${mode}-`)),
    model: MODEL,
    permissionMode: 'default',
    includePartialMessages: false,
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      out.toolsSeen.push(toolName)
      if (toolName !== 'AskUserQuestion') return { behavior: 'allow' as const, updatedInput: input }
      out.input = input
      const questions = questionsIn(input)
      if (mode === 'C') {
        const answers = questions.map((question) => ({ question, answers: [ANSWER] }))
        return { behavior: 'deny' as const, message: JSON.stringify({ answers }) }
      }
      if (mode === 'D') {
        const answers = Object.fromEntries(questions.map((question) => [question, ANSWER]))
        return { behavior: 'allow' as const, updatedInput: { ...input, answers } }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },
  }

  if (mode === 'B') {
    // The CLI only emits the kinds that are declared here (without any, it degrades to behavior with no dialog)
    opts.supportedDialogKinds = [
      'ask_user_question',
      'askUserQuestion',
      'user_question',
      'question',
      'tool_question',
      'refusal_fallback_prompt',
    ]
    opts.onUserDialog = async (req: { dialogKind: string; payload: Record<string, unknown> }) => {
      out.dialogs.push(req.dialogKind)
      console.log(`  [onUserDialog] kind=${req.dialogKind} payload=${JSON.stringify(req.payload).slice(0, 600)}`)
      return { behavior: 'cancelled' as const }
    }
  }

  const q = query({ prompt: PROMPT, options: opts as never })
  for await (const msg of q) {
    const m = msg as Record<string, unknown>
    const content = (m.message as { content?: unknown[] } | undefined)?.content ?? []
    if (m.type === 'assistant') {
      for (const c of content) {
        const b = c as Record<string, unknown>
        if (b.type === 'tool_use') {
          console.log(`  [assistant] tool_use: ${String(b.name)}`)
          if (b.name === 'AskUserQuestion') askId = String(b.id)
        }
        if (b.type === 'text' && typeof b.text === 'string') lastText = b.text
      }
    }
    if (m.type === 'user') {
      for (const c of content) {
        const b = c as Record<string, unknown>
        if (b.type !== 'tool_result' || (askId !== null && b.tool_use_id !== askId)) continue
        out.isError = b.is_error === true
        out.content = contentText(b.content)
        console.log(`  [tool_result] is_error=${out.isError} ${out.content.slice(0, 300)}`)
      }
    }
    if (m.type === 'result') {
      out.reply = typeof m.result === 'string' && m.result ? m.result : lastText
      break
    }
  }
  return out
}

function report(o: Outcome): void {
  console.log(`\n──────── ${o.mode}: ${MODES[o.mode]} ────────`)
  console.log('canUseTool saw AskUserQuestion:', o.input !== null ? 'yes' : 'no')
  console.log('tools canUseTool saw:', o.toolsSeen.join(', ') || '(none)')
  console.log('args the tool received:', o.input === null ? '(not seen)' : JSON.stringify(o.input).slice(0, 300))
  console.log('onUserDialog call count:', o.mode === 'B' ? `${o.dialogs.length} ${o.dialogs.join(', ')}`.trim() : '(not declared)')
  console.log('tool result is_error:', o.isError ?? '(no tool result)')
  console.log('tool result content:', o.content ? o.content.slice(0, 700) : '(none)')
  console.log("model's reply:", o.reply || '(none)')
}

const modes = modesToRun()
console.log(`model: ${MODEL}; question "${QUESTION}", answered "${ANSWER}"`)
const outcomes: Outcome[] = []
for (const mode of modes) {
  console.log(`\n>>> mode ${mode}: ${MODES[mode]}`)
  outcomes.push(await run(mode))
}
for (const o of outcomes) report(o)
process.exit(0)
