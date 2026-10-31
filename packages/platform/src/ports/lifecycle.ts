import type {
  UpdateStatus,
} from '@cc/protocol/client'
import type { Unsubscribe } from './common.js'

/**
 * Updates for the app itself (issue #43).
 *
 * **Both checking and installing happen entirely on the other side (the host).** Asking the
 * registry and running `npm i -g` is something a browser cannot do, and more importantly,
 * leaving the check to the launcher means the stale copy already installed on the person's
 * machine is the one that answers — that stale copy's comparison being wrong is what #42 was.
 *
 * The port carries exactly one thing: status. The screen only needs to know "where are we
 * right now". Relaunching into what was installed is not this port's: only a desktop window
 * can do it, through `RelaunchPort` (#352).
 */
export interface UpdatePort {
  /** What is known right now. With `force`, asks the registry again (Settings' "Check now") */
  status(force?: boolean): Promise<UpdateStatus>
  /** Turns periodic checking on and off */
  setAuto(enabled: boolean): Promise<UpdateStatus>
  /** "Apply updates automatically when idle" on and off (#352); the host installs, the window applies */
  setAutoApply(enabled: boolean): Promise<UpdateStatus>
  /**
   * Installs the new version. **Only when the person clicks it.**
   *
   * Responds as soon as it starts — `npm i -g` routinely exceeds the RPC timeout, and a
   * contract that waits for it to finish would make an install that actually succeeded look
   * like a failure on screen. The rest arrives as events.
   */
  apply(): Promise<UpdateStatus>
  /**
   * An agent's "Apply now" (#665): this window's answer to an `update_apply_request` event — whether its own "Apply
   * now" could relaunch right now, and why not. A ticket comes back to the one window the host picks; that window
   * relaunches on the `update_apply_go` naming it.
   */
  answerApply(a: { requestId: string; ready: boolean; reason?: string; version?: string }): Promise<{ ticket: string | null }>
  /** The picked window's outcome (#665): `started` right before relaunching, then `error`, or neither once the shell accepted it */
  reportApply(r: { requestId: string; ticket: string; started?: boolean; error?: string }): Promise<void>
}

/** What a window tells the host about its own failures */
export interface DiagnosticsPort {
  /** The screen crashed (the error boundary caught it): the host writes it to its log. Fire and forget; never rejects */
  reportCrash(r: { message: string; stack: string; componentStack: string; version?: string }): Promise<void>
}

/**
 * Leftover processes still running from our folders (requested by the person, 2026-09-07).
 *
 * A dev server an agent started with bash has neither its parent process nor its process
 * group tied to ours, so our shutdown procedure cannot catch it (measured). So instead of
 * killing it, we **show it** and let the person choose — if the app silently killed something
 * the person started by hand in the same folder, cleaning up an orphan would mean cutting off
 * someone else's work.
 */
export interface ProcessPort {
  strays(): Promise<{ pid: number; command: string; cwd: string }[]>
  stop(pids: number[]): Promise<{ stopped: number }>
}

/**
 * Background mode (#280): whether quitting the app leaves the agent host and its running sessions
 * going. Off by default; with it off, quitting stops them as it always did.
 *
 * Only a desktop app whose host is held by the keeper can offer this — the keeper is what
 * outlives the window. A platform that cannot leaves `Platform.background` undefined, and the
 * setting is not shown, rather than shown as a switch that does nothing.
 */
export interface BackgroundPort {
  get(): Promise<boolean>
  /** @returns the mode now in force */
  set(on: boolean): Promise<boolean>
}

/** Whether relaunching starts the update just installed (#352), and why not when it does not */
export type RelaunchCheck = {
  ready: boolean
  /** Why not, for the update line's tooltip */
  reason?: string
  /** The version a relaunch would start, when the bundle says */
  version?: string
}

/**
 * "Apply now" (#352): relaunching the window into the version the host just installed.
 *
 * Only a desktop app whose host is held by the keeper can offer this: the keeper is told first and
 * holds the host and every agent through the relaunch, whatever background mode says, and the new
 * window then switches the keeper and host to its build. A platform that cannot leaves
 * `Platform.relaunch` undefined, and the update line keeps saying "restart to finish".
 */
export interface RelaunchPort {
  /** Whether a relaunch now would start a different build than this window (the bundle on disk was replaced) */
  check(): Promise<RelaunchCheck>
  /** Announces the relaunch to the keeper, then relaunches. Rejects, saying why, when the agents could not be held */
  relaunch(): Promise<void>
  /**
   * Whether the host is running anything a person would lose (the keeper's activity report: a
   * session working or waiting, a terminal, a command), null while unknown. Called now and on every
   * change. What "Apply updates automatically when idle" waits for.
   * @returns unsubscribes
   */
  watchBusy(cb: (busy: boolean | null) => void): Unsubscribe
}
