import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PriorDiscovery, Tool } from '@modelcontextprotocol/client'
import type { AppProcess } from './app-process.js'
import type { ScannedApp } from './discovery.js'
import type { AppManifest } from './manifest.js'
import type { AppRef } from './ref.js'
import type { AppCaller } from './runtime-types.js'
import type { Audience } from './visibility.js'

/**
 * One discovered app as the runtime holds it (`ExternalApps`) — where it was found, what its
 * manifest says, and its lifecycle (`Life`), which outlives every process the app starts.
 */

export type Scope = { key: string; projectId: string | null; root: string; trusted: boolean }

/** One app's lifecycle — a process comes and goes, but this stays alive as long as the app is in the list */
export type Life = {
  proc: AppProcess | null
  starting: Promise<AppProcess> | null
  /** The process of the start under way, from its spawn until it is ready or fails (#839): a halt stops it too */
  spawning: AppProcess | null
  /** Consecutive failure count — counts both a failed start and an unannounced exit */
  failures: number
  /** The next startup never happens before this time (exponential backoff) */
  retryAt: number
  /** The reason for the last failure (including the tail of stderr) */
  lastError: string | null
  /** Stopped — failed maxFailures times in a row. Does not start again until a person restarts it */
  gaveUp: boolean
  /** The spec generation discovered — the next startup connects without probing */
  verdict: PriorDiscovery | undefined
  /**
   * A generation number. Raised every time it stops or changes — if a startup in progress finishes
   * with a different number than when it began, that process is already stale and is discarded (so an
   * app that should start with a changed manifest never starts with the old command instead).
   */
  epoch: number
  inflight: number
  /** Waiters for inflight to reach 0 — a check (C-3) never cuts off a call in progress, it waits and then restarts */
  idleWaiters: (() => void)[]
  /**
   * The fingerprint of the app folder the last-started process saw (C-4) — null if it has never
   * started. Reflecting a change compares the current folder against this, and restarts if they
   * differ. Survives the process going down: an edit made while it was idle and stopped still counts
   * as "changed".
   */
  stamp: string | null
  /**
   * The fingerprint the last process that **actually started** read (C-4) — the list's `codeStamp`.
   * Unlike `stamp`, a failed startup never changes this: an open screen compares it against the code
   * currently running to tell whether it is showing stale HTML. Reopening a screen against new code
   * that failed to start would show nothing but the failure.
   */
  loaded: string | null
  idle: NodeJS.Timeout | null
  /** The current process's tool list (names and audience passed validation), and the reasons for anything filtered out */
  tools: AppTool[] | null
  toolWarnings: string[]
  /**
   * The last tool list read — unlike `tools`, **this survives the process going down** (A-5).
   *
   * Attaching an app to a session needs its tool list, but knowing the tool list requires starting
   * the app. Starting every attached app every time a session starts would break "zero app processes
   * while idle" (the performance budget) for a single session. The list read once is remembered, and
   * re-read and announced if changed the next time the app starts. If the manifest changes, entries
   * are rebuilt fresh, so the old list disappears along with it.
   */
  known: AppTool[] | null
  /**
   * The current process's pipe number. An open run carries the pipe number it was born under, and the
   * broker only accepts a run under that same number — so even if the app restarts, a dead process's
   * run id never works on the new pipe.
   */
  pipeId: number
  /**
   * The app said it is busy with background work (#1236, `uses.background`): what it said, and the pipe of the
   * process that said it. Honoured only while that process is the current one (`AppLifecycle.busyReason`), so a busy
   * report from a process stopping or already replaced holds nothing; cleared when the process stops or dies.
   */
  busy: { pipeId: number; reason: string } | null
}

export type AppTool = { tool: Tool; visibility: Audience[] }

/**
 * Why an app may not run right now (`ExternalApps.blocker`) — the one answer every door asks: a call, a start, a
 * check, a reload, and the list's status. `reason` is worded for the person or agent who reads it verbatim.
 */
export type Blocker = { kind: 'invalid' | 'untrusted' | 'unconfirmed' | 'removing' | 'failed'; reason: string }

/**
 * Clears what a run of failures left behind — the count, the backoff, the reason, the stop — and the remembered spec
 * generation. Every door that gives an app a fresh start passes through here: Restart, a check, a reload on changed
 * files, a restored version, a changed secret. The generation goes too: it describes the code that last connected,
 * and the SDK warns that a stale one fails (a modern verdict against a server that went back to the 2025 SDK) or,
 * worse, succeeds silently forever (a legacy verdict against an upgraded server keeps speaking `initialize`). Only
 * Restart used to clear it, so a check or a reload after switching SDKs kept connecting the old way.
 */
export function resetLife(L: Life): void {
  Object.assign(L, { failures: 0, retryAt: 0, lastError: null, gaveUp: false, verdict: undefined })
}

/** A currently open host → app call */
export type OpenRun = {
  entry: AppEntry
  pipeId: number
  tool: string
  /** Whoever called it — the basis for finding who started it by walking up the chain (where D-4's question is attributed) */
  caller: AppCaller
  /** Set when the call ends or is cancelled — broker work beneath this run stops together with it */
  abort: AbortController
}

export type AppEntry = {
  ref: AppRef
  scope: Scope
  /** Exactly what discovery saw — the baseline the next scan is compared against */
  found: ScannedApp
  dir: string
  /** The result of layering the runtime's own validation (a reserved id) on top of discovery's */
  manifest: AppManifest | null
  error: string | null
  warnings: string[]
  life: Life
}

/**
 * Whether Centralu keeps copies of this app's code (E-1). A user-folder app has no git; nor has a root app whose project
 * is not a repository (#1141) — every user-folder app moved into a project is one. A root app in a repository is
 * versioned by git like any project app: copying a whole repository on every start would cost what git already keeps.
 */
export function keepsVersions(e: AppEntry): boolean {
  return e.ref.projectId === null || (e.found.root === true && !existsSync(join(e.dir, '.git')))
}

/** The reason an app with an invalid manifest does not run — the same words for every door */
export const invalidReason = (e: AppEntry): string => `This app's manifest is invalid: ${e.error ?? 'unknown error'}`

/** A new entry for what discovery found — a lifecycle that has never started (`ExternalApps.rescan`) */
export function newEntry(scope: Scope, found: ScannedApp, reservedIds: readonly string[]): AppEntry {
  let { manifest, error } = found
  if (manifest && reservedIds.includes(manifest.id)) {
    // A reserved id would inherit the retired control app's rows and sessions (#97, RESERVED_APP_IDS)
    error = `"${manifest.id}" is a reserved app id — use another id`
    manifest = null
  }
  return {
    ref: { projectId: scope.projectId, appId: found.folder },
    scope,
    found,
    dir: found.dir,
    manifest,
    error,
    warnings: found.warnings,
    life: {
      proc: null,
      starting: null,
      spawning: null,
      failures: 0,
      retryAt: 0,
      lastError: null,
      gaveUp: false,
      verdict: undefined,
      epoch: 0,
      inflight: 0,
      idleWaiters: [],
      stamp: null,
      loaded: null,
      idle: null,
      tools: null,
      toolWarnings: [],
      known: null,
      pipeId: 0,
      busy: null,
    },
  }
}
