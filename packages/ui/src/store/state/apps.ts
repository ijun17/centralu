import type { AppArrival } from '@cc/core'
import type {
  AppQuestion,
  ExternalAppInfo,
} from '@cc/protocol'

/** External apps: the list, their questions and change counters, import, share and remove. */
export type AppsSlice = {
  /**
   * How many times, per external app, we have heard "the state changed" (M4 B-5). Keyed by
   * `externalAppKey`. The size of the value carries no meaning — only **the fact that it changed**
   * does. An open `AppFrame` reads this as `changeSignal` and sends the view
   * `centralu/notifications/changed`. Counted even when the app is not in the list. The store does
   * not know the external app list, and missing a signal while waiting for the list is worse.
   */
  externalAppChanges: Record<string, number>
  /**
   * The view instance whose call caused the last bump to that app's counter — only when the change
   * came from a call the view itself made, otherwise `null` (`external_app_state_changed.cause`).
   * `AppFrame` does not notify when the counter went up by exactly one and that one was its own.
   */
  externalAppChangedBy: Record<string, string | null>
  /**
   * How many times, per external app, we have heard "a row shown in the runs panel started or
   * finished" (M4 D-6, `external_app_runs_changed`). Keyed by `externalAppKey`. Read only by the
   * runs panel (`RunsPanel`) — it does not reach the view. Calls to read-only tools, and the chains
   * they start, also arrive here.
   */
  externalAppRunChanges: Record<string, number>
  /**
   * Discovered external apps and their state (M4 A-8) — a copy of the host's `apps.list`. The host
   * holds the source of truth: this is never edited here, only re-read in full when
   * `external_apps_changed` arrives. The list every screen reads (status, scope) is built from it by
   * `app-catalog.ts`.
   */
  externalApps: ExternalAppInfo[]
  refreshExternalApps(): Promise<void>
  /**
   * Apps a trusted project gained since this window last looked (#1141): trusted with the project, so the inbox says so
   * once (`noteAppArrivals` in @cc/core). Kept in the workspace snapshot, with what was seen, until opened or Done.
   */
  appArrivals: AppArrival[]
  /** Per trusted project, the keys of the apps this window has seen it with (`noteAppArrivals`) */
  appsSeen: Record<string, string[]>
  /** Takes an app's arrival notice off the inbox: opened, or Done */
  dismissAppArrival(key: string): void
  /**
   * Capability questions for chains started from a view (M4 D-4) — a copy of the host's
   * `apps.questions`. Re-read in full when `external_app_questions_changed` arrives, and on
   * reconnect. A question stands on the pinned view of the app that started the chain (`origin`),
   * and that app's sidebar row carries a badge. Questions for chains started from a session are not
   * here — they are that session's approval card instead.
   */
  appQuestions: AppQuestion[]
  /** How many times the questions changed — the signal for wherever remembered answers are shown (the runs panel) to re-read */
  appQuestionsVersion: number
  /** How many times a remembered cross-project consent was added or revoked (#371) — Settings re-reads its list on it */
  projectConsentsVersion: number
  refreshAppQuestions(): Promise<void>
  /** Answers a capability question — a failure (the question is already closed) is reported as a toast and the list is re-read */
  answerAppQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /**
   * Removes an app from the user folder (M4 A-7). The list follows from the host's broadcast. The
   * caller is confirmed first.
   * @returns whether it was removed — a failure is reported as a toast
   */
  /** `machine`: a linked machine's user-folder app (#82), removed on that machine and nowhere else */
  removeUserApp(appId: string, machine?: string | null): Promise<boolean>
  /**
   * Shares a project app with the person's other projects, or stops (#371 part A). The list follows
   * from the host's broadcast; a failure is reported as a toast.
   */
  setAppShared(projectId: string, appId: string, shared: boolean): Promise<void>
  /**
   * The app-import window (M4 E-3) — opened by the sidebar's Import and by deep links (E-4).
   * `source` is the origin to pre-fill in the window (the deep link's address), and `fromLink`
   * tells the window it was "opened by a link." The window reads or downloads nothing until the
   * person presses Review.
   */
  importDialog: { source: string; fromLink: boolean; at: number } | null
  openImport(source?: string, fromLink?: boolean): void
  closeImport(): void
}
