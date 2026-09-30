/**
 * An app's error bundle (M4 C-6) — holds the moment an app failed to start, crashed, or a tool
 * failed, as one unit.
 *
 * The person is the one who sends it: the app's screen offers "send to the building session", and
 * pressing it sends this bundle to the building session. **It is never sent automatically** — this
 * stops an agent from fixing and breaking things over and over without the person knowing (plan
 * C-6). So the host only collects it and answers when asked.
 *
 * What goes in it: what happened (kind, reason), when, which tool with what arguments (a summary —
 * secrets are masked the same way the run ledger masks them), and the last lines the app printed to
 * stderr at that moment. In spike S-6, the thing that cost the building agent the most time
 * chasing was "the server is still up but there is no reason anywhere" — stderr is this bundle's
 * body.
 */

export type AppErrorKind = 'start' | 'crash' | 'tool'

export type AppErrorBundle = {
  kind: AppErrorKind
  at: number
  /** A one-line reason — why it failed to start, the shape it ended in, or the failure a tool returned */
  message: string
  /** The last lines of the app's stderr (after secrets are masked) */
  stderr: string[]
  /** The tool that failed (tool errors only) */
  tool: string | null
  /** A summary of that call's arguments — secrets are masked by name (tool errors only) */
  args: string | null
  runId: string | null
  /**
   * This failure came from a person's decision (D-4) — the person denied this call's request (or a
   * request further up its chain). Since it is not a bug in the app, the screen does not show it as
   * an error and instead states the decision (the place to reverse it is that app's record panel:
   * Permissions → Forget). It is also not sent to the building session — sending it would make the
   * building agent "fix" code that is working as intended. It appears only on a tool-failure bundle.
   */
  denied: { appId: string; projectId: string | null; name: string; capability: string; text: string } | null
  /** The text that can be sent to the building session as-is */
  text: string
}

/** How many bundles are kept per app — the most recent only. Cleared when the host restarts (keeping them longer is the run ledger's job). */
export const ERRORS_KEPT = 10

const KIND_LABEL: Record<AppErrorKind, string> = {
  start: 'the app could not start',
  crash: "the app's process ended",
  tool: 'a tool call failed',
}

export function errorBundle(app: string, input: Omit<AppErrorBundle, 'text' | 'denied'> & { denied?: AppErrorBundle['denied'] }): AppErrorBundle {
  const b = { ...input, denied: input.denied ?? null }
  const lines = [`App ${app}: ${KIND_LABEL[b.kind]} (${new Date(b.at).toISOString()})`]
  if (b.tool) lines.push(`Tool: ${b.tool}`)
  if (b.args !== null) lines.push(`Arguments: ${b.args}`)
  if (b.runId) lines.push(`Run id: ${b.runId}`)
  lines.push(`Reason: ${b.message}`)
  if (b.denied) lines.push(`The person denied this: ${b.denied.name} may not ${b.denied.text}`)
  lines.push(b.stderr.length ? `stderr (last lines):\n${b.stderr.join('\n')}` : 'stderr: (the app printed nothing)')
  return { ...b, text: lines.join('\n') }
}
