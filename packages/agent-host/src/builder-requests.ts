import { builderErrorFrame, builderRequestFrame, type Attachment, type BuilderRequestFacts, type BuilderRunFact, type SessionInfo } from '@cc/protocol'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'

/**
 * A message from an app to its building session (M4 C-5) — the body of the RPC `apps.askBuilder`.
 *
 * What a person types in the input line below an app view ("fix this here") goes to that app's
 * building session. The person never leaves the app. A header built from **facts the host knows**
 * is prepended to the message (the protocol's `builderRequestFrame`): which app and which view it
 * came from, and, if the app is stopped or the latest run failed, that fact. The facts are read
 * from the host's own records — the view comes from the instance (ViewHost), status from the app
 * list, and the run from the run record. Not trusting whatever the caller claims about "this is
 * the view" follows the same principle as #93 and #94.
 *
 * The sending path is the same as a person's message (`send`) — attachments get paths attached the
 * same way the composer does, and a sleeping session receives it after waking up. main.ts (rpc.ts)
 * and the tests share the same function (the same arrangement as app-home-view.ts).
 */
export type BuilderRequestDeps = {
  apps: ExternalApps
  /** The view instance — if absent (a host with no view hosting), it does not say which view */
  views?: ViewHost
  builderOf(ref: AppRef): SessionInfo | null
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
}

export type BuilderRequest = {
  ref: AppRef
  text: string
  attachments?: Attachment[]
  /** The instance of the fixed view the person was looking at */
  instanceId?: string
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

export async function askBuilder(deps: BuilderRequestDeps, req: BuilderRequest): Promise<{ sessionId: string }> {
  const text = req.text.trim()
  if (!text && !req.attachments?.length) refuse('Write what to change, or attach a screenshot')
  const info = deps.apps.list().find((a) => a.appId === req.ref.appId && a.projectId === req.ref.projectId)
  if (!info) refuse('This app no longer exists')
  const builder = deps.builderOf(req.ref)
  if (!builder) refuse('This app has no builder session yet. Start one, then ask again')
  const facts: BuilderRequestFacts = {
    app: { appId: info.appId, name: info.name ?? info.appId },
    screen: null,
    stopped: info.status === 'crashed' || info.status === 'failed' ? { status: info.status, reason: info.error } : null,
    latestRun: null,
  }
  if (req.instanceId) {
    const inst = deps.views?.describe(req.instanceId) ?? null
    if (!inst || inst.app.appId !== req.ref.appId || inst.app.projectId !== req.ref.projectId) {
      refuse("That view is not open for this app. Reopen the app's view and ask again")
    }
    // The fixed view is the one the home tool opened — a view not in a conversation does not use
    // this line
    facts.screen = { tool: info.home ?? '(no home tool)', resourceUri: inst.uri }
  }
  // Carried only if the latest run was not a success — a successful run is not evidence for "this
  // does not work"
  facts.latestRun = notOk(deps.apps.runs(req.ref, 1)[0])
  await deps.send(builder.id, builderRequestFrame(facts, text), req.attachments)
  return { sessionId: builder.id }
}

const CALLERS: readonly string[] = ['view', 'session', 'app'] satisfies BuilderRunFact['callerKind'][]
const NOT_OK: readonly string[] = ['running', 'error', 'cancelled', 'rejected'] satisfies BuilderRunFact['status'][]

/** One record entry (the store gives it as text) → a header fact. null if it succeeded or the shape is unrecognized */
function notOk(run: { tool: string; callerKind: string; status: string; error: string | null } | undefined): BuilderRunFact | null {
  if (!run || !NOT_OK.includes(run.status) || !CALLERS.includes(run.callerKind)) return null
  return {
    tool: run.tool,
    callerKind: run.callerKind as BuilderRunFact['callerKind'],
    status: run.status as BuilderRunFact['status'],
    error: run.error,
  }
}

/**
 * Sends one error bundle to that app's building session (M4 C-6) — the body of the RPC
 * `apps.sendError`. This only happens when the person clicks "Send to builder." The host never
 * sends one on its own (so the agent does not repeat a cycle of fixing and breaking things behind
 * the person's back, plan C-6).
 *
 * **One bundle goes exactly once.** Before sending, the runtime is marked "sent" (clicking twice,
 * or clicking from two windows, still lets only one through), and if the send fails, that mark is
 * removed — an unsent bundle is never left recorded as sent. What reaches the agent is the app's
 * output enclosed as a quotation (`builderErrorFrame`): stderr may carry arbitrary outside text the
 * app forwarded.
 */
export async function sendErrorToBuilder(deps: BuilderRequestDeps, ref: AppRef, at: number): Promise<{ sessionId: string }> {
  const info = deps.apps.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)
  if (!info) refuse('This app no longer exists')
  const builder = deps.builderOf(ref)
  if (!builder) refuse('This app has no builder session yet. Start one, then send the error')
  const bundle = deps.apps.markErrorSent(ref, at)
  if (bundle === 'sent') refuse('This error was already sent to the builder')
  if (!bundle) refuse('This error is no longer kept. If it happens again, send the new one')
  /*
   * A call stopped because the person denied a capability is not a bug in the app (M4 D-4) —
   * sending it to the building agent would make it "fix" perfectly fine code. The view never
   * offers a send button for this bundle, and this is blocked here too.
   */
  if (bundle.denied) {
    deps.apps.unmarkErrorSent(ref, at)
    refuse(`This stopped because you did not allow ${bundle.denied.name} to ${bundle.denied.text}; nothing in the app is broken, so it is not sent to the builder`)
  }
  try {
    await deps.send(builder.id, builderErrorFrame({ appId: info.appId, name: info.name ?? info.appId }, bundle.text))
  } catch (err) {
    deps.apps.unmarkErrorSent(ref, at)
    throw err
  }
  return { sessionId: builder.id }
}
