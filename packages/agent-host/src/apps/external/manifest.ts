import { z } from 'zod'
import { APP_ID_MAX_LENGTH, GRID_SPAN_MAX, RESERVED_NAME_PREFIX, serverNameProblem, type GridSpan } from '@cc/protocol'
import { HOST_CAPABILITIES, isHostCapability } from './capabilities.js'

/**
 * The manifest of an external app, `centralu.app.json` (M4 A-1).
 *
 * One app folder is one app, and this file is what turns that folder into an app. We never read the
 * rest of the folder (server code, screens) — this file decides only the command that starts the
 * server, the name shown to the person and agents, and what the app **declares** it wants to use.
 *
 * Validation is a single set of zod schemas. If the rules were scattered across if-statements around
 * the codebase, finding "which check looks at this field" would take a search every time, and the
 * loosest check would be the hole (a lesson from #93).
 */

export const MANIFEST_FILE = 'centralu.app.json'

/**
 * The manifest version this Centralu knows how to read.
 *
 * This field exists because teammates can be on different Centralu versions (from the plan, "the
 * shape of one app"). Guessing at an unrecognized version would mean running a field whose meaning
 * changed under its old meaning — so instead, when the version differs, it is never read, and the
 * message is "update Centralu".
 */
export const MANIFEST_VERSION = 1

/**
 * The manifest file's size cap. In practice it is a bit over 1KiB — just a few lines of description
 * and a few lists. Since folder watching re-reads it on every change, this keeps the host from
 * loading an entire large file into memory even if someone places one here.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * The naming rule for a tool inside an app. Returns a reason a person can read if it is broken, or
 * null if it is fine.
 *
 * `__` is forbidden for the same reason underscores are forbidden in an app id (#93): inside a
 * session, a tool name expands to `mcp__app-<id>__<tool>`, with `__` as the separator. If a tool
 * name contained `__`, one app could create an extra name segment and make its tool read as if it
 * belonged to someone else.
 *
 * The tool list is something the app server states while running, so it never appears in the
 * manifest — this check is instead shared between the place that reads the list (the runtime) and
 * the manifest's `home` field.
 */
export function toolNameError(name: string): string | null {
  if (name.length === 0) return 'a tool name is empty'
  if (name.includes('__')) return `a tool name cannot contain "__" (it separates names in a session's tool names): ${name}`
  return null
}

/**
 * A secret name = the environment variable name the app process receives it as.
 *
 * A variable we hand the app ourselves (`CENTRALU_APP_DATA` and similar) and the host's own
 * variables (`CC_*`) cannot be taken as a secret name — if a value the user stored overwrote the
 * data folder path, the app would end up writing into someone else's folder.
 */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const RESERVED_ENV_PREFIXES = ['CENTRALU_', 'CC_'] as const

/**
 * The shape of a capability name in `uses.host`. The vocabulary (the closed list) is decided by
 * `capabilities.ts` — a malformed name is a manifest error, while a well-formed but unrecognized
 * name is only a warning (`parseManifest`): when an older Centralu encounters a capability a newer
 * one added, refusing just that capability is better than stopping the whole app (the same reasoning
 * as warning-only on unknown fields).
 */
const HOST_CAPABILITY = /^[a-z][a-z0-9_.-]{0,63}$/

/**
 * A tool name written in `uses.agent` (M4 D-1) — the same shape as an adapter's name (`claude`,
 * `codex`). The manifest has no way to know which tools actually exist (it varies by machine). So
 * only the shape is checked, and a tool that does not exist is refused with a reason when requested.
 */
const AGENT_TOOL = /^[a-z][a-z0-9-]{0,31}$/

const appIdField = z.string().superRefine((id, ctx) => {
  // Validation is a single function (`serverNameProblem`, #93); only the wording is attached here — this wording is what a person and the building agent read, in the app list's reason and check's report
  const problem = serverNameProblem(id)
  if (problem === 'reserved') ctx.addIssue({ code: 'custom', message: `ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself` })
  if (problem === 'shape') {
    ctx.addIssue({
      code: 'custom',
      message: `an app id is lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit — no underscores: "__" separates names in a session's tool names`,
    })
  }
})

const toolNameField = z.string().superRefine((name, ctx) => {
  const err = toolNameError(name)
  if (err) ctx.addIssue({ code: 'custom', message: err })
})

const secretNameField = z.string().superRefine((name, ctx) => {
  if (!SECRET_NAME.test(name)) {
    ctx.addIssue({ code: 'custom', message: `a secret name must be an environment variable name (capital letters, digits and underscores): ${name}` })
  } else if (RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    ctx.addIssue({ code: 'custom', message: `names starting with ${RESERVED_ENV_PREFIXES.join(' or ')} are Centralu's own: ${name}` })
  }
})

/** The origins to add to a screen's CSP — the same four fields as ext-apps's `McpUiResourceCsp`. Assembled by B-3 */
const CSP_KEYS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const
const cspField = z.object(Object.fromEntries(CSP_KEYS.map((k) => [k, z.array(z.string()).optional()])))

/**
 * How a screen's origin is handled (B-3, spikes S-1 and S-8). `opaque` is the default — the inner
 * frame has no origin, so browser storage never mixes between apps. `app` is a **request** for a
 * real origin on a per-app fixed port. This is the escape hatch for an app that breaks without
 * browser storage or blob workers (5 of 86 public apps tested, including map-server, which could not
 * load its map tiles). The values match ViewHost's `OriginMode`, the same two words.
 */
export const VIEW_ORIGINS = ['opaque', 'app'] as const
const VIEW_KEYS = ['origin', 'span'] as const
const SPAN_KEYS = ['cols', 'rows'] as const

/**
 * The manifest's `view.span` — the span, in grid cells, the app recommends for its panel on the grid (#306) — read
 * into a span, or none, with what a person and the building agent should hear about it.
 *
 * A recommendation, so it never makes an app invalid: the person's own choices come before it, and an app without one
 * stands at 1 × 1 as before. A whole number outside 1..`GRID_SPAN_MAX` is clamped into it, as the grid clamps a span
 * that does not fit; anything that is not two whole numbers is ignored. Both say so in a warning (`check` reports it).
 */
export function readViewSpan(raw: unknown): { span?: GridSpan; warning?: string } {
  if (raw === undefined) return {}
  const v = raw as { cols?: unknown; rows?: unknown }
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !whole(v.cols) || !whole(v.rows)) {
    return { warning: `view.span: not a span, ignored — write two whole numbers of grid cells, like { "cols": 2, "rows": 1 }` }
  }
  const clamp = (n: number) => Math.min(GRID_SPAN_MAX, Math.max(1, n))
  const span = { cols: clamp(v.cols), rows: clamp(v.rows) }
  if (span.cols === v.cols && span.rows === v.rows) return { span }
  return { span, warning: `view.span: each side is 1 to ${GRID_SPAN_MAX} cells — read as ${span.cols} × ${span.rows}` }
}

const USES_KEYS = ['agent', 'apps', 'host'] as const
const SERVER_KEYS = ['command', 'args'] as const

const ManifestSchema = z.object({
  manifestVersion: z.number().superRefine((v, ctx) => {
    if (v !== MANIFEST_VERSION) {
      ctx.addIssue({
        code: 'custom',
        message: `this Centralu reads manifestVersion ${MANIFEST_VERSION} only (got ${v}) — update Centralu, or ask whoever made the app for a version this Centralu reads`,
      })
    }
  }),
  id: appIdField,
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(2000),
  server: z.object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
  }),
  /** The tool that opens the fixed screen (B-2) — whether it actually exists in the tool list is known only once the server starts */
  home: toolNameField.optional(),
  /**
   * The capabilities an app **declares that it uses** (D). This is a declaration, not a grant — the
   * grant comes from the person on first use (D-4). If absent, the app uses nothing: treating an
   * absent declaration as "everything" would be dangerous.
   */
  uses: z
    .object({
      /**
       * Can it ask for an agent (D-1)? `true` means "the person's default agent" — the project's
       * default tool for a project app, or the orchestrator's tool for a user-folder app. To request
       * a specific tool, list it explicitly (`["codex"]`): a tool not in the list is refused. The
       * narrower the declaration, the narrower what the person is asked to allow (D-4 asks per tool).
       */
      agent: z
        .union([
          z.boolean(),
          z.array(
            z.string().superRefine((t, ctx) => {
              if (!AGENT_TOOL.test(t)) ctx.addIssue({ code: 'custom', message: `not the shape of an agent tool name (for example "claude", "codex"): ${t}` })
            }),
          ),
        ])
        .optional(),
      apps: z.array(appIdField).optional(),
      host: z
        .array(
          z.string().superRefine((h, ctx) => {
            if (!HOST_CAPABILITY.test(h)) ctx.addIssue({ code: 'custom', message: `not the shape of a host capability name: ${h}` })
          }),
        )
        .optional(),
    })
    .default({}),
  /** Only the name is listed here. The value lives only on the user's machine (the runtime's secrets file) */
  secrets: z.array(secretNameField).optional(),
  csp: cspField.optional(),
  /**
   * How to display the screen (B-3). Defaults to an opaque origin when absent.
   *
   * An unrecognized **value** is rejected (unlike an unrecognized field, which is only a warning). A
   * typo like `"orgin": "app"` stays a warning, but silently reading `"origin": "per-app"` as the
   * default would leave the author with no way to find out why storage does not work. This follows
   * the same principle as manifestVersion: never run an app with a value whose meaning is unknown.
   */
  view: z
    .object({
      origin: z.enum(VIEW_ORIGINS).default('opaque'),
      /** The panel span the app recommends on the grid (#306) — checked and clamped by `readViewSpan`, never an error */
      span: z
        .unknown()
        .optional()
        .transform((v) => readViewSpan(v).span),
    })
    .optional(),
})

export type AppManifest = z.infer<typeof ManifestSchema>

export type ManifestResult =
  | { ok: true; manifest: AppManifest; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

/**
 * Raw manifest text → validation result.
 *
 * **An unrecognized field only produces a warning.** When an older Centralu encounters a field a
 * newer one added (teammates on different versions), reading what it recognizes and reporting what
 * it does not is better than rejecting the whole app. A change whose meaning changes is done by
 * bumping manifestVersion, not by adding a field.
 */
export function parseManifest(text: string): ManifestResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `${MANIFEST_FILE} is not JSON: ${(e as Error).message}`, warnings: [] }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${MANIFEST_FILE} must be a JSON object`, warnings: [] }
  }
  const warnings = unknownFields(raw as Record<string, unknown>)
  const view = (raw as { view?: unknown }).view
  const spanWarning = view && typeof view === 'object' ? readViewSpan((view as { span?: unknown }).span).warning : undefined
  if (spanWarning) warnings.push(spanWarning)
  const parsed = ManifestSchema.safeParse(raw, { reportInput: true })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map(describeIssue).join('; '), warnings }
  }
  for (const h of parsed.data.uses.host ?? []) {
    if (!isHostCapability(h)) warnings.push(`uses.host: Centralu has no capability "${h}" — it can give: ${HOST_CAPABILITIES.join(', ')} (asking for it is refused)`)
  }
  return { ok: true, manifest: parsed.data, warnings }
}

const TOP_KEYS = Object.keys(ManifestSchema.shape)

function unknownFields(raw: Record<string, unknown>): string[] {
  const out: string[] = []
  const check = (obj: unknown, known: readonly string[], prefix: string) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) out.push(`unknown field, ignored: ${prefix}${k}`)
    }
  }
  check(raw, TOP_KEYS, '')
  check(raw.server, SERVER_KEYS, 'server.')
  check(raw.uses, USES_KEYS, 'uses.')
  check(raw.csp, CSP_KEYS, 'csp.')
  check(raw.view, VIEW_KEYS, 'view.')
  check((raw.view as { span?: unknown } | undefined)?.span, SPAN_KEYS, 'view.span.')
  return out
}

/** One line for a person and the building agent to read — which field is wrong, and why */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String).join('.') || '(the whole file)'
  if (issue.code === 'invalid_type' && issue.input === undefined) return `${path}: missing`
  return `${path}: ${issue.message}`
}
