import { z } from 'zod'

/**
 * The stream-json lines Antigravity CLI (`agy`) prints in print mode, parsed at the boundary (agent-host.md §2: nothing of
 * a tool's shape leaves `adapters/agy/`). Only the fields read are named; the rest pass through (`looseObject`), since
 * `agy` is another program at another version. Shapes as measured on `agy` 1.4.7 (docs/plans/antigravity-adapter.md §1.1,
 * the recordings under `recordings/`).
 */

const nullish = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined)

export const AgyUsage = z.looseObject({
  input_tokens: nullish(z.number()),
  output_tokens: nullish(z.number()),
  thinking_tokens: nullish(z.number()),
  cache_read_tokens: nullish(z.number()),
})
export type AgyUsage = z.infer<typeof AgyUsage>

export const AgyInit = z.looseObject({
  event: z.literal('init'),
  conversation_id: z.string(),
  init: nullish(z.looseObject({ model: nullish(z.string()), cwd: nullish(z.string()), tools: nullish(z.array(z.string())), permission_mode: nullish(z.string()) })),
})

export const AgySubagent = z.looseObject({
  type_name: nullish(z.string()),
  role: nullish(z.string()),
  initial_prompt: nullish(z.string()),
  conversation_id: nullish(z.string()),
})

export const AgyStep = z.looseObject({
  conversation_id: nullish(z.string()),
  step_index: z.number(),
  state: z.string(),
  step_type: z.string(),
  text_delta: nullish(z.string()),
  usage: nullish(AgyUsage),
  tool_name: nullish(z.string()),
  tool_info: nullish(
    z.looseObject({
      name: nullish(z.string()),
      parameters: nullish(z.record(z.string(), z.unknown())),
      output: nullish(z.string()),
      error: nullish(z.looseObject({ type: nullish(z.string()), message: nullish(z.string()) })),
    }),
  ),
  subagent_info: nullish(z.looseObject({ subagents: nullish(z.array(AgySubagent)) })),
})
export type AgyStep = z.infer<typeof AgyStep>

export const AgyStepUpdate = z.looseObject({ event: z.literal('step_update'), step_update: AgyStep })

export const AgyResult = z.looseObject({
  event: z.literal('result'),
  result: z.looseObject({
    conversation_id: nullish(z.string()),
    status: z.string(),
    error: nullish(z.string()),
    response: nullish(z.string()),
    num_turns: nullish(z.number()),
    usage: nullish(AgyUsage),
    denied_actions: nullish(z.array(z.looseObject({ action: nullish(z.string()), display_name: nullish(z.string()) }))),
  }),
})
export type AgyResult = z.infer<typeof AgyResult>['result']

export type AgyFrame =
  | z.infer<typeof AgyInit>
  | z.infer<typeof AgyStepUpdate>
  | z.infer<typeof AgyResult>
  /** A line that is JSON with an `event` this adapter does not read, or a known one whose shape changed */
  | { event: 'unknown'; name: string }
  /** A line that is not JSON at all */
  | { event: 'unparsed'; line: string }

const EventName = z.looseObject({ event: z.string() })

/** One stdout line in our terms */
export function parseLine(line: string): AgyFrame {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { event: 'unparsed', line }
  }
  const named = EventName.safeParse(raw)
  const name = named.success ? named.data.event : ''
  const schema = name === 'init' ? AgyInit : name === 'step_update' ? AgyStepUpdate : name === 'result' ? AgyResult : null
  const parsed = schema?.safeParse(raw)
  return parsed?.success ? parsed.data : { event: 'unknown', name: name || '(no event)' }
}

/** The stdin line that runs one turn: text only, since stream input takes only `text` blocks (§8) */
export function userLine(text: string): string {
  return JSON.stringify({ event: 'user', message: { content: text } })
}

/** The stderr lines the adapter reads; everything else goes to the host log only */
export const STDERR = {
  /** `--conversation <id>` named a conversation agy does not have: it starts a new one and runs the turn there (§1.4) */
  notFound: /^warning: conversation "([^"]+)" not found/,
  /** The turn was stopped by SIGINT (§1.5) */
  interrupted: /^error: interrupted\b/,
  /** No login: `agy` never prompts without a terminal (§1.7) */
  loggedOut: /authentication required/i,
  /** The changelog's structured error line: canonical status, retryability, error id */
  agyError: /^AGY_ERROR:\s*(\{.*\})\s*$/,
  error: /^error:\s*(.*)$/,
} as const
