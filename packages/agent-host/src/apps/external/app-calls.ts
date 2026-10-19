import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AppLifecycle } from './app-lifecycle.js'
import type { AppEntry, Blocker, OpenRun } from './app-entry.js'
import type { AppProcess } from './app-process.js'
import { RUN_META } from './broker.js'
import type { CapabilityDenial, CapabilityOrigin } from './desk.js'
import type { HeldErrorBundle } from './errors.js'
import { NOTICE_META } from './notices.js'
import type { AppRef } from './ref.js'
import { RunRow, type RunLedger } from './runs.js'
import type { AppCallOutcome, AppCaller, AppRunStatus, RuntimeTiming } from './runtime-types.js'
import type { Audience } from './visibility.js'

/** What a call asks of the runtime (`ExternalApps`) */
export type CallsHost = {
  readonly timing: RuntimeTiming
  readonly lifecycle: AppLifecycle
  /** Where the run ledger is stored (A-6) — the runtime's, already announcing (`announcingLedger`); null records nothing */
  readonly runs: RunLedger | null
  blocker(e: AppEntry): Blocker | null
  masker(ref: AppRef): (text: string) => string
  recordError(e: AppEntry, b: Omit<HeldErrorBundle, 'text' | 'denied'> & { denied?: HeldErrorBundle['denied'] }, proc?: AppProcess | null): void
  emitChanged(ref: AppRef, cause?: AppCaller | null): void
  /** The address this app may later post a notice to for that session (#1161 item 1), or null: not declared, or no key */
  noticeAddress(e: AppEntry, sessionId: string): string | null
}

/** How a caller follows one call (`ExternalApps.call`) */
export type AppCallOptions = {
  signal?: AbortSignal
  /**
   * Called once, the moment a run id is decided — used by a caller that needs the id before the
   * outcome is known (A-5's "long-running calls": returning "still running, run id is …" before
   * Codex's cap, rather than waiting for the outcome).
   */
  onRun?: (runId: string) => void
  /**
   * The text of a progress notification the app sent for this call (D) — a line the broker sent
   * the app, like "waiting on the person's approval in session X", is relayed up through this call
   * by the template's helper. Moved to somewhere the caller can display it (a session's tool card).
   * A wordless keepalive notification is never passed through.
   */
  onProgress?: (message: string) => void
}

/**
 * The single path through which an app's tool is called (M4 A-4), moved out of the runtime
 * (`runtime.ts`, whose `call` is the door) with the runs it holds open: the broker's gatekeeper asks
 * against them (D), a call between apps continues the chain through them (D-2), and the person's
 * question is attributed by walking up them (D-4).
 */
export class AppCalls {
  /** Run id → open run. The broker's gatekeeper asks against this */
  readonly openRuns = new Map<string, OpenRun>()
  /**
   * Open run → the person denied this run's request (or one further down its chain) (D-4) — recorded
   * by the desk. If that run ends in failure, this is attached to that failure's error bundle (it is
   * not a bug in the app, it is the person's decision), and if the run belongs to an app that called
   * another, it is passed up to the parent: if A called B, B's request was denied so B failed, and
   * that is why A failed, then the reason A's screen states is that same denial. Cleared once the run
   * ends.
   */
  private denials = new Map<string, CapabilityDenial>()
  constructor(private host: CallsHost) {}

  /** The person denied this run's request (D-4) — recorded by the desk, for an open run, once */
  denied(runId: string, d: CapabilityDenial): void {
    if (this.openRuns.has(runId) && !this.denials.has(runId)) this.denials.set(runId, d)
  }

  /**
   * The chain leading up to this run (D-5) — the (app, tool) pairs from the call that started the
   * chain to this run. Only open runs are followed: a call beneath it lives only while its parent is
   * open (it is cancelled once the parent ends), so a running request's chain is never broken.
   */
  chainOf(runId: string): { ref: AppRef; tool: string }[] {
    const path: { ref: AppRef; tool: string }[] = []
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && hops < 32; hops++) {
      path.unshift({ ref: run.entry.ref, tool: run.tool })
      run = run.caller.kind === 'app' ? this.openRuns.get(run.caller.parentRunId) : undefined
    }
    return path
  }

  /**
   * Who started this run's chain (D-4) — walking up through parents to the first caller that is not
   * an app. For a screen, the answer is that screen's app (the question is attributed to its fixed
   * screen). If a parent along the way has already ended, this cannot be followed — returns null.
   */
  chainOrigin(runId: string): CapabilityOrigin | null {
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && run.caller.kind === 'app' && hops < 32; hops++) run = this.openRuns.get(run.caller.parentRunId)
    if (!run) return null
    if (run.caller.kind === 'session') return { kind: 'session', sessionId: run.caller.sessionId }
    if (run.caller.kind === 'view') return { kind: 'view', app: run.entry.ref }
    return null
  }

  async call(e: AppEntry, name: string, args: Record<string, unknown>, caller: AppCaller, opts: AppCallOptions = {}): Promise<AppCallOutcome> {
    const runId = `run_${randomUUID()}`
    opts.onRun?.(runId)
    const t0 = Date.now()
    /*
     * A row is created as `running` the moment a call comes in, and corrected with its outcome when it
     * ends — a denial is also a row. What is masked is every secret stored for this app: whichever of
     * the arguments, the result, or the failure reason it ends up mixed into, only the name survives.
     */
    const redact = this.host.masker(e.ref)
    const row = new RunRow(
      this.host.runs,
      {
        id: runId,
        projectId: e.ref.projectId,
        appId: e.ref.appId,
        kind: 'tool',
        tool: name,
        callerKind: caller.kind,
        callerSessionId: caller.kind === 'session' ? caller.sessionId : null,
        parentRunId: caller.kind === 'app' ? caller.parentRunId : null,
        createdAt: t0,
      },
      args,
      redact,
    )
    row.open()
    /** Whether it was actually sent to the app — "changed" only fires for a call that reached the app (a denial, cancellation while starting, or a failed startup changes nothing) */
    let sent = false
    /*
     * Is this a read-only tool (`readOnlyHint: true`)? Reading changes nothing, so "changed" is never
     * emitted for it either. Measured (65acb43): the template screen re-calls `show` on every
     * notification, and that `show` itself emits another notification, so a single screen called
     * `show` roughly 700 times per second (618 run-ledger rows in one second, 2035 in three seconds).
     * A tool with no annotation is treated as one that can change something, following MCP's own
     * default — if the wrong choice here is "does not notify", the screen shows a stale value.
     */
    let readOnly = false
    /** The process that received this call — its stderr is attached to the error bundle if the call fails (C-6) */
    let callee: AppProcess | null = null
    const done = (status: AppRunStatus, result: CallToolResult | null, error: string | null): AppCallOutcome => {
      const denial = this.denials.get(runId) ?? null
      this.denials.delete(runId)
      if (denial && status !== 'ok' && caller.kind === 'app' && this.openRuns.has(caller.parentRunId) && !this.denials.has(caller.parentRunId)) {
        this.denials.set(caller.parentRunId, denial)
      }
      /*
       * A call that reached the app failed (C-6) — this records only what could plausibly be the app's
       * own fault. A denial is policy, and a failure to start was already recorded separately by the
       * startup path. Arguments are masked under the same rule as the ledger — this bundle can become
       * the building session's prompt.
       */
      if (status === 'error' && sent) {
        this.host.recordError(
          e,
          {
            kind: 'tool',
            at: Date.now(),
            message: redact(error ?? '').split('\n')[0]!,
            stderr: [],
            tool: name,
            args: row.summary(),
            runId,
            denied: denial && { appId: denial.app.appId, projectId: denial.app.projectId, name: denial.name, capability: denial.capability, text: denial.text },
          },
          callee,
        )
      }
      const durationMs = Date.now() - t0
      row.close(status, error, result)
      if (sent && !readOnly) this.host.emitChanged(e.ref, caller)
      return { runId, status, result, error, durationMs }
    }

    // Checks that end before anything is sent to the app — do not even need to start a process
    const blocked = this.host.blocker(e)
    if (blocked) return done('rejected', null, blocked.reason)
    let parent: OpenRun | null = null
    if (caller.kind === 'app') {
      parent = this.openRuns.get(caller.parentRunId) ?? null
      if (!parent) return done('rejected', null, `The run that asked for this call is not open: ${caller.parentRunId}`)
    }
    if (opts.signal?.aborted) return done('cancelled', null, 'Cancelled before the call was sent')

    try {
      return await this.host.lifecycle.use(e, async (proc) => {
        const found = e.life.tools?.find((t) => t.tool.name === name)
        if (!found) return done('rejected', null, `This app has no tool named ${name}`)
        /*
         * A screen may call only `app` tools, and an agent or another app only `model` tools. A session
         * only ever receives `model` tools in its list to begin with (A-5), but a tool could still be
         * called if its name is known — hiding something from the list and blocking the call are
         * different things, and the blocking happens here.
         */
        const need: Audience = caller.kind === 'view' ? 'app' : 'model'
        if (!found.visibility.includes(need)) {
          return done('rejected', null, `${name} is not open to ${need === 'app' ? 'views' : 'agents'} (visibility: ${JSON.stringify(found.visibility)})`)
        }

        const upstream = [opts.signal, parent?.abort.signal].filter((x): x is AbortSignal => !!x)
        /*
         * If it was cancelled while the app was starting, this is never sent. Measured: a call
         * cancelled while starting ran a 5-second tool to completion anyway — a listener attached to a
         * signal that has already fired is never called.
         */
        if (upstream.some((sig) => sig.aborted)) return done('cancelled', null, 'Cancelled while the app was starting')
        const abort = new AbortController()
        const onUp = () => abort.abort(new Error('the caller cancelled this call'))
        for (const sig of upstream) sig.addEventListener('abort', onUp, { once: true })
        this.openRuns.set(runId, { entry: e, pipeId: e.life.pipeId, tool: name, caller, abort })
        sent = true
        readOnly = found.tool.annotations?.readOnlyHint === true
        callee = proc
        // A session started this chain: an app that declares notices gets that session's address with the call (#1161 item 1)
        const origin = this.chainOrigin(runId)
        const notice = origin?.kind === 'session' ? this.host.noticeAddress(e, origin.sessionId) : null
        try {
          /*
           * Why `onprogress` is provided: the MCP SDK only attaches a progress token to a request when
           * this is present (in the client's request — without a token, the app has no way to send a
           * progress notification). So until now, `resetTimeoutOnProgress` did nothing at all. While an
           * app requests an agent and waits (D-1, which can take minutes), the template's helper has to
           * relay that wait up as this call's own progress, or the call gets cut off at
           * `callTimeoutMs`. If the notification carries a message, it is passed to the caller
           * (`onProgress`) — while the app waits on a person, the calling session's card can state what
           * it is waiting for. Before this, it was dropped here and never reached anywhere.
           */
          const result = await proc.client.callTool(
            { name, arguments: args, _meta: { [RUN_META]: runId, ...(notice ? { [NOTICE_META]: notice } : {}) } },
            {
              signal: abort.signal,
              timeout: this.host.timing.callTimeoutMs,
              resetTimeoutOnProgress: true,
              onprogress: (p) => {
                if (typeof p.message === 'string' && p.message.trim()) opts.onProgress?.(p.message)
              },
            },
          )
          return result.isError ? done('error', result, resultText(result) || 'The tool returned an error with no text') : done('ok', result, null)
        } catch (err) {
          if (abort.signal.aborted) return done('cancelled', null, 'The caller cancelled this call')
          return done('error', null, (err as Error).message)
        } finally {
          this.openRuns.delete(runId)
          // When a run ends, the broker work beneath it also ends — so nothing is left behind even if the app answered without waiting
          abort.abort()
          for (const sig of upstream) sig.removeEventListener('abort', onUp)
        }
      })
    } catch (err) {
      // Failed to start (a failed startup, or changed while backing off) — never reached the app, but this is not a policy denial
      return done('error', null, (err as Error).message)
    }
  }
}

/** Joins together the text parts of a result — becomes the one line a person reads (RPC's `text`) and a failure's reason */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
}
