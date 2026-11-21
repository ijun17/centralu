import { builderErrorFrame, builderRequestOf, type Attachment, type SessionInfo, sameApp } from '@cc/protocol'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'
import { rpcError } from './rpc-error.js'

/**
 * A message from an app to its building session, the body of `apps.askBuilder`: what a person types below an app view ("fix
 * this here") goes to that app's building session. A header of facts the host knows (the protocol's `builderRequestFrame`) is
 * prepended: which app and view, and whether the app is stopped or the latest run failed. They are read from the host's own
 * records (view from the instance, status from the app list, run from the run record), never from what the caller claims (#93,
 * #94). It sends as a person's message does (`send`): attachments get paths, a sleeping session receives it after waking.
 * main.ts (rpc.ts) and the tests share it
 */
export type BuilderRequestDeps = {
  apps: ExternalApps
  views?: ViewHost
  builderOf(ref: AppRef): SessionInfo | null
  send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
  /**
   * A script made the call (the limited credential, #1468): `send` writes its text as the script's, and the header does not say
   * the person wrote it
   */
  byScript?: boolean
}

export type BuilderRequest = {
  ref: AppRef
  text: string
  attachments?: Attachment[]
  instanceId?: string
}

function refuse(message: string): never {
  throw rpcError(message)
}

export async function askBuilder(deps: BuilderRequestDeps, req: BuilderRequest): Promise<{ sessionId: string }> {
  const app = deps.apps.list().find((a) => sameApp(a, req.ref))
  const builder = deps.builderOf(req.ref)
  let view: { uri: string } | null | undefined
  if (req.instanceId) {
    const inst = deps.views?.describe(req.instanceId) ?? null
    view = inst && sameApp(inst.app, req.ref) ? inst : null
  }
  const built = builderRequestOf({
    text: req.text,
    hasAttachments: !!req.attachments?.length,
    app,
    builder,
    view,
    latestRun: deps.apps.runs(req.ref, 1)[0],
    byScript: deps.byScript === true,
  })
  if ('refusal' in built) refuse(built.refusal)
  await deps.send(built.builder.id, built.frame, req.attachments)
  return { sessionId: built.builder.id }
}

/**
 * Sends one error bundle to the app's building session, the body of `apps.sendError`, only when the person clicks "Send to
 * builder": the host never sends one on its own, or the agent would repeat a cycle of fixing and breaking behind the person's
 * back (plan C-6). One bundle goes exactly once: the runtime is marked "sent" before sending (two clicks or two windows let one
 * through) and the mark is removed if the send fails. The agent gets the app's output as a quotation (`builderErrorFrame`), as
 * stderr may carry arbitrary text the app forwarded
 */
export async function sendErrorToBuilder(deps: BuilderRequestDeps, ref: AppRef, at: number): Promise<{ sessionId: string }> {
  const info = deps.apps.list().find((a) => sameApp(a, ref))
  if (!info) refuse('This app no longer exists')
  const builder = deps.builderOf(ref)
  if (!builder) refuse('This app has no builder session yet. Start one, then send the error')
  const bundle = deps.apps.markErrorSent(ref, at)
  if (bundle === 'sent') refuse('This error was already sent to the builder')
  if (!bundle) refuse('This error is no longer kept. If it happens again, send the new one')
  /*
   * A call stopped because the person denied a capability is not a bug in the app: sending it would make the building agent "fix"
   * fine code. The view offers no send button for it, and this blocks it too
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
