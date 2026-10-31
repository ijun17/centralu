import { builderErrorFrame, builderRequestOf, type Attachment, type SessionInfo } from '@cc/protocol'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'
import { rpcError } from './rpc-error.js'

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
  throw rpcError(message)
}

export async function askBuilder(deps: BuilderRequestDeps, req: BuilderRequest): Promise<{ sessionId: string }> {
  const app = deps.apps.list().find((a) => a.appId === req.ref.appId && a.projectId === req.ref.projectId)
  const builder = deps.builderOf(req.ref)
  let view: { uri: string } | null | undefined
  if (req.instanceId) {
    const inst = deps.views?.describe(req.instanceId) ?? null
    view = inst && inst.app.appId === req.ref.appId && inst.app.projectId === req.ref.projectId ? inst : null
  }
  const built = builderRequestOf({
    text: req.text,
    hasAttachments: !!req.attachments?.length,
    app,
    builder,
    view,
    latestRun: deps.apps.runs(req.ref, 1)[0],
  })
  if ('refusal' in built) refuse(built.refusal)
  await deps.send(built.builder.id, built.frame, req.attachments)
  return { sessionId: built.builder.id }
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
