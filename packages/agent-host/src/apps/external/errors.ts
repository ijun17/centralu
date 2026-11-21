import type { AppErrorBundle } from '@cc/protocol'

/**
 * An app's error bundle (M4 C-6): the moment an app failed to start, crashed, or a tool failed, as one unit. The person sends
 * it: the app's screen offers "send to the building session". **It is never sent automatically**, which stops an agent from
 * fixing and breaking things over and over without the person knowing (plan C-6); the host only collects it and answers when
 * asked. It holds what happened (kind, reason), when, which tool with what arguments (a summary, secrets masked as the run
 * ledger masks them) and the last lines the app printed to stderr then: in spike S-6 what cost the building agent the most time
 * was "the server is still up but there is no reason anywhere", and stderr is the bundle's body.
 */

/**
 * The bundle as the host holds it: the protocol's `AppErrorBundle` without `sentAt`, which is kept apart (by kind and time,
 * `ErrorLog` in error-log.ts) so a bundle replaced when stderr is re-captured stays sent. Derived from the protocol's type,
 * never copied by hand (a copy drifted, #428). What its fields hold:
 * - `message`: a one-line reason: why it failed to start, the shape it ended in, or the failure a tool returned.
 * - `stderr`: the last lines of the app's stderr, secrets masked.
 * - `tool`, `args`: the failed tool and a summary of that call's arguments, secrets masked by name (tool errors only).
 * - `denied`: the failure came from a person's decision (D-4): the person denied this call's request (or one further up its
 *   chain), so it is not a bug in the app: the screen states the decision (to reverse it: the app's record panel, Permissions →
 *   Forget) and it is not sent to the building session, which would "fix" working code. Tool failures only.
 * - `text`: the text that can be sent to the building session as-is.
 */
export type HeldErrorBundle = Omit<AppErrorBundle, 'sentAt'>

export type AppErrorKind = AppErrorBundle['kind']

/** An error bundle returned on request — carries the time it was sent, if it was sent to the building session (C-6) */
export type SentErrorBundle = AppErrorBundle

/** How many bundles are kept per app — the most recent only. Cleared when the host restarts (keeping them longer is the run ledger's job). */
export const ERRORS_KEPT = 10

const KIND_LABEL: Record<AppErrorKind, string> = {
  start: 'the app could not start',
  crash: "the app's process ended",
  tool: 'a tool call failed',
}

export function errorBundle(app: string, input: Omit<HeldErrorBundle, 'text' | 'denied'> & { denied?: HeldErrorBundle['denied'] }): HeldErrorBundle {
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
