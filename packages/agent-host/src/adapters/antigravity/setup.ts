import type { ToolSetup } from '@cc/protocol'
import type { ToolSetupControl } from '../contract.js'
import { hasSignIn, installAgy, isInstalled, type AgyHome, type InstallIo } from './agent-files.js'
import { InstallFailure } from './failure.js'
import type { AgyArchive } from './release.js'
import { runSignIn, type SignInDeps, type SignInResult } from './sign-in.js'

/**
 * Antigravity's setup on this host, as one state (docs/plans/antigravity-adapter.md §3–§4): installed or not, an install
 * running, signed in or not, a sign-in running. The two actions run one at a time each (a second start joins the first),
 * and only when asked: nothing here starts on its own. What a screen reads is `current()`; every change is told to the
 * listeners (the host's `tool_setup` event).
 *
 * The states, and what moves between them:
 *
 *     not_installed --install--> installing --done--> signed_out | ready
 *                                           --fail/cancel--> not_installed (failure said)
 *     signed_out --signIn--> signing_in --done--> ready (plan said)
 *                                        --fail/cancel/timeout--> signed_out (failure said)
 *     ready --a session's -32000--> signed_out
 */

type Running<T> = { abort: AbortController; done: Promise<T> }

export type AgySetupDeps = {
  home: AgyHome
  /** This machine's archive, or null where Google ships no build */
  archive: AgyArchive | null
  version: string
  installIo?: InstallIo
  signIn?: SignInDeps
  /** Replaced by a test that models the agent's sign-in */
  runSignIn?: (signal: AbortSignal) => Promise<SignInResult>
  /** Replaced by a test that models the install */
  runInstall?: (signal: AbortSignal, progress: (p: { received: number; total: number | null }) => void) => Promise<void>
}

export class AgySetup implements ToolSetupControl {
  private installing: Running<void> | null = null
  private signingIn: Running<void> | null = null
  private progress: { received: number; total: number | null } | null = null
  private failure: ToolSetup['failure'] = undefined
  private plan: ToolSetup['plan'] = undefined
  /** A session found the tool signed out (`-32000`) since the last sign-in: what is on disk no longer works */
  private signedOutSeen = false
  private readonly listeners = new Set<(setup: ToolSetup) => void>()

  constructor(private readonly deps: AgySetupDeps) {}

  installed(): boolean {
    return this.deps.archive !== null && isInstalled(this.deps.home, this.deps.archive)
  }

  signedIn(): boolean {
    return this.installed() && !this.signedOutSeen && hasSignIn(this.deps.home)
  }

  current(): ToolSetup {
    const base = { install: 'centralu', signIn: 'centralu' } as const
    const failure = this.failure ? { failure: this.failure } : {}
    if (this.deps.archive === null) {
      return { ...base, state: 'not_installed', failure: { reason: 'unsupported_platform', message: 'Google ships no Antigravity agent for this system' } }
    }
    if (this.installing) return { ...base, state: 'installing', ...(this.progress ? { progress: this.progress } : {}) }
    if (!this.installed()) return { ...base, state: 'not_installed', ...failure }
    if (this.signingIn) return { ...base, state: 'signing_in' }
    if (!this.signedIn()) return { ...base, state: 'signed_out', ...failure }
    return { ...base, state: 'ready', ...(this.plan ? { plan: this.plan } : {}) }
  }

  onChange(listener: (setup: ToolSetup) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    const now = this.current()
    for (const l of this.listeners) l(now)
  }

  install(): ToolSetup {
    const archive = this.deps.archive
    if (this.installing || !archive || this.installed()) return this.current()
    const abort = new AbortController()
    this.failure = undefined
    this.progress = { received: 0, total: null }
    const run =
      this.deps.runInstall ??
      ((signal, onProgress) =>
        installAgy(this.deps.home, archive, this.deps.version, { signal, onProgress, ...(this.deps.installIo ? { io: this.deps.installIo } : {}) }))
    const done = run(abort.signal, (p) => {
      this.progress = p
      this.changed()
    }).then(
      () => {},
      (err: unknown) => {
        this.failure = failureOf(err, 'install')
        console.error(`[Antigravity] install ended: ${this.failure.reason}: ${this.failure.message}`)
      },
    )
    this.installing = { abort, done }
    void done.finally(() => {
      if (this.installing?.done === done) this.installing = null
      this.progress = null
      this.changed()
    })
    this.changed()
    return this.current()
  }

  async cancelInstall(): Promise<ToolSetup> {
    const running = this.installing
    if (running) {
      running.abort.abort()
      await running.done
    }
    return this.current()
  }

  signIn(): ToolSetup {
    const archive = this.deps.archive
    if (this.signingIn || !archive || !this.installed()) return this.current()
    const abort = new AbortController()
    this.failure = undefined
    const run = this.deps.runSignIn ?? ((signal) => runSignIn(this.deps.home, archive, signal, this.deps.signIn ?? {}))
    const done = run(abort.signal).then(
      (result) => {
        this.signedOutSeen = false
        this.plan = result.plan ?? undefined
        // The agent answered, yet wrote no sign-in it will use: said, not taken for ready
        if (!hasSignIn(this.deps.home)) this.failure = { reason: 'failed', message: 'Antigravity answered the sign-in but kept no account' }
      },
      (err: unknown) => {
        this.failure = failureOf(err, 'sign-in')
        console.error(`[Antigravity] sign-in ended: ${this.failure.reason}`)
      },
    )
    this.signingIn = { abort, done }
    void done.finally(() => {
      if (this.signingIn?.done === done) this.signingIn = null
      this.changed()
    })
    this.changed()
    return this.current()
  }

  async cancelSignIn(): Promise<ToolSetup> {
    const running = this.signingIn
    if (running) {
      running.abort.abort()
      await running.done
    }
    return this.current()
  }

  /** A session's open was refused as not signed in (`-32000`): the line offers the sign-in again */
  noteSignedOut(): void {
    if (this.signedOutSeen) return
    this.signedOutSeen = true
    this.plan = undefined
    this.changed()
  }
}

function failureOf(err: unknown, what: 'install' | 'sign-in'): NonNullable<ToolSetup['failure']> {
  if (err instanceof InstallFailure) return { reason: err.reason, message: err.message }
  return { reason: 'failed', message: `The ${what} failed: ${err instanceof Error ? err.message : String(err)}` }
}
