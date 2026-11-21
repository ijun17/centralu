import type { AppArrival } from '@cc/core'
import type {
  AppQuestion,
  ExternalAppInfo,
} from '@cc/protocol/client'

/** External apps: the list, their questions and change counters, import, share and remove. */
export type AppsSlice = {
  /**
   * "The state changed" counts per `appKeyOf` (M4 B-5); only a change means anything. `AppFrame` sends the view
   * `centralu/notifications/changed` on it. Counted for apps not in the list too: missing a signal is worse.
   */
  externalAppChanges: Record<string, number>
  /** The view whose own call caused the last change (`cause`), else `null`: `AppFrame` skips a rise of one that was its own. */
  externalAppChangedBy: Record<string, string | null>
  /** `external_app_runs_changed` counts per `appKeyOf` (M4 D-6), read by `RunsPanel` only; read-only tools' calls count too. */
  externalAppRunChanges: Record<string, number>
  /** The host's `apps.list` (M4 A-8), read again in full on `external_apps_changed`; screens read `app-catalog.ts`'s list. */
  externalApps: ExternalAppInfo[]
  refreshExternalApps(): Promise<void>
  /**
   * Apps a trusted project gained since this window last looked (#1141), trusted with it, so the inbox says so once
   * (`noteAppArrivals`). In the workspace snapshot until opened or Done.
   */
  appArrivals: AppArrival[]
  appsSeen: Record<string, string[]>
  dismissAppArrival(key: string): void
  /**
   * Capability questions of chains a view started (M4 D-4), the host's `apps.questions`, shown on the `origin` app's
   * pinned view. A session's chains ask through its approval card instead.
   */
  appQuestions: AppQuestion[]
  /** Raised when the questions change: the runs panel reads its remembered answers again */
  appQuestionsVersion: number
  /** Raised when a cross-project consent is added or revoked (#371): Settings reads its list again */
  projectConsentsVersion: number
  refreshAppQuestions(): Promise<void>
  /** A failure (the question already closed) is toasted and the list read again */
  answerAppQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /**
   * Removes a user-folder app (M4 A-7), on `machine` only (#82); the caller confirms first. Returns whether it was
   * removed; a failure is toasted.
   */
  removeUserApp(appId: string, machine?: string | null): Promise<boolean>
  /** Shares a project app with the person's other projects (#371); the list follows the host's broadcast. */
  setAppShared(projectId: string, appId: string, shared: boolean): Promise<void>
  /** Off on this computer (#1938), for an app another computer runs for the same repository. */
  setAppOff(projectId: string, appId: string, off: boolean): Promise<void>
  /** The app-import window (M4 E-3, E-4): `source` pre-fills it; it reads or downloads nothing before Review. */
  importDialog: { source: string; fromLink: boolean; at: number } | null
  openImport(source?: string, fromLink?: boolean): void
  closeImport(): void
}
