import type {
  UpdateStatus,
} from '@cc/protocol/client'
import type { Unsubscribe } from './common.js'

/**
 * The app's own updates (#43), checked and installed by the host: a browser cannot run `npm i -g`, and a check left
 * to the launcher has its stale installed copy answer, which was #42. Relaunching is `RelaunchPort`'s (#352).
 */
export interface UpdatePort {
  /** `force` asks the registry again (Settings' "Check now") */
  status(force?: boolean): Promise<UpdateStatus>
  /** Periodic checking */
  setAuto(enabled: boolean): Promise<UpdateStatus>
  /** "Apply updates automatically when idle" (#352): the host installs, the window applies */
  setAutoApply(enabled: boolean): Promise<UpdateStatus>
  /**
   * Only on the person's click. Answers once started: `npm i -g` routinely outlasts the RPC timeout, which would show
   * a good install as failed. The rest comes as events.
   */
  apply(): Promise<UpdateStatus>
  /**
   * An agent's "Apply now" (#665): this window's answer to `update_apply_request`, whether it could relaunch now. The
   * one window the host picks gets a ticket and relaunches on the `update_apply_go` naming it.
   */
  answerApply(a: { requestId: string; ready: boolean; reason?: string; version?: string }): Promise<{ ticket: string | null }>
  /** The picked window's outcome (#665): `started` before relaunching, then `error`, or neither once the shell accepted */
  reportApply(r: { requestId: string; ticket: string; started?: boolean; error?: string }): Promise<void>
}

export interface DiagnosticsPort {
  /** A screen the error boundary caught, for the host's log. Fire and forget; never rejects */
  reportCrash(r: { message: string; stack: string; componentStack: string; version?: string }): Promise<void>
}

/**
 * Leftover processes from the app's folders. A dev server an agent started with bash
 * is tied to neither the app's process nor its process group, so shutdown cannot catch it (measured). It is shown, not
 * killed: the person may have started it by hand.
 */
export interface ProcessPort {
  strays(): Promise<{ pid: number; command: string; cwd: string }[]>
  stop(pids: number[]): Promise<{ stopped: number }>
}

/**
 * Background mode (#280): quitting leaves the host and its sessions running; off by default. Only a desktop app whose
 * host the keeper holds can; elsewhere `Platform.background` is undefined and the setting is not shown.
 */
export interface BackgroundPort {
  get(): Promise<boolean>
  /** @returns the mode now in force */
  set(on: boolean): Promise<boolean>
}

export type RelaunchCheck = {
  ready: boolean
  /** For the update line's tooltip */
  reason?: string
  /** When the bundle says */
  version?: string
  /**
   * Applying stops the host and the next one continues from it (#1895): turns go on, terminals and Run commands
   * start again. Without a keeper the window stops it before relaunching; a keeper stops it and exits. Absent where
   * the window cannot tell (Windows, Linux, a browser)
   */
  restartsHost?: boolean
  /** The keeper reports busy (`watchBusy`), so automatic updates wait for idle; absent without it: a press applies */
  idleReported?: boolean
}

/**
 * "Apply now" (#352): relaunches into the version the host installed, the host stopped first
 * (`RelaunchCheck.restartsHost`). Desktop only; elsewhere the update line keeps saying "restart to finish".
 */
export interface RelaunchPort {
  /** Whether the bundle on disk was replaced by a different build than this window's */
  check(): Promise<RelaunchCheck>
  /** Rejects, saying why, when the agents could not be held */
  relaunch(): Promise<void>
  /**
   * The keeper's activity report (a session working or waiting, a terminal, a command); null while unknown. Called now
   * and on every change; idle auto-apply waits on it.
   */
  watchBusy(cb: (busy: boolean | null) => void): Unsubscribe
}
