import { appKeyOf } from '@cc/protocol'
import type { AppPermission, AppUsage, AppQuestion } from '@cc/protocol'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'

/** What a person decides about an app: capability questions, remembered permissions, usage, sharing and secrets (M4 D, E) */
export class AppSettingsMock {
  /** Setting or clearing a secret that reached the host (M4 E) — tests check what went to which app under which name */
  readonly secretWrites: { appId: string; projectId: string | null; name: string; value: string | null }[] = []
  /** What `setShared` received (#371 part A) — a test reads it to see the switch reached the host */
  readonly sharedWrites: { appId: string; projectId: string; shared: boolean }[] = []
  /**
   * A capability question from a chain that started at a screen (M4 D-4) — a test sets one up
   * with `askAppQuestion`. Broadcasts like the host, and when an answer comes in, resolves
   * whichever side was waiting on that question (a test-supplied `appToolHandler`). This is how
   * "answering resumes the stalled screen's call" is checked over a real path.
   */
  appQuestionList: AppQuestion[] = []
  readonly answeredQuestions: { questionId: string; decision: 'allow' | 'deny' }[] = []
  private questionWaiters = new Map<string, (d: 'allow' | 'deny') => void>()
  /** Remembered answers (M4 D-4) — the key is `(project ?? _user)/app`. A test fills this in */
  readonly appPermissions = new Map<string, AppPermission[]>()
  /** Agent usage (M4 D-5) — the key is `(project ?? _user)/app`. A test fills this in */
  readonly appUsage = new Map<string, AppUsage>()
  readonly forgottenPermissions: { appId: string; projectId: string | null; capability: string }[] = []
  /** Scenario helper: the host sets up a capability question — returns a promise that resolves once an answer arrives (used from Playwright) */
  askAppQuestion(q: AppQuestion): Promise<'allow' | 'deny'> {
    this.appQuestionList.push(structuredClone(q))
    this.emit({ type: 'external_app_questions_changed' })
    return new Promise((resolve) => this.questionWaiters.set(q.id, resolve))
  }
  readonly apps = {
    // A capability question (M4 D-4) — like the real thing: reads the list, and on an answer removes it from the list and broadcasts. Rejects a closed question
    questions: async (): Promise<AppQuestion[]> => structuredClone(this.appQuestionList),
    answerQuestion: async (questionId: string, decision: 'allow' | 'deny') => {
      const at = this.appQuestionList.findIndex((q) => q.id === questionId)
      if (at === -1) throw new Error('That question is no longer open — it timed out, or the app stopped waiting')
      this.appQuestionList.splice(at, 1)
      this.answeredQuestions.push({ questionId, decision })
      this.emit({ type: 'external_app_questions_changed' })
      this.questionWaiters.get(questionId)?.(decision)
      this.questionWaiters.delete(questionId)
    },
    permissions: async (appId: string, projectId: string | null): Promise<AppPermission[]> =>
      structuredClone(this.appPermissions.get(appKeyOf(projectId, appId)) ?? []),
    forgetPermission: async (appId: string, projectId: string | null, capability: string) => {
      const key = appKeyOf(projectId, appId)
      this.appPermissions.set(key, (this.appPermissions.get(key) ?? []).filter((p) => p.capability !== capability))
      this.forgottenPermissions.push({ appId, projectId, capability })
    },
    // Agent usage (M4 D-5) — a test fills this in. If absent, 0, like the host
    usage: async (appId: string, projectId: string | null): Promise<AppUsage> =>
      structuredClone(
        this.appUsage.get(appKeyOf(projectId, appId)) ?? {
          day: { runs: 0, durationMs: 0, tokens: null },
          month: { runs: 0, durationMs: 0, tokens: null },
        },
      ),
    /**
     * A secret (M4 E). Like the real thing (`ExternalApps.updateSecret`): only lets in a
     * declared name (the list's `secrets`), rejects an empty value with the same wording, and
     * carries only present/absent in the listing before broadcasting. Deleting does not need
     * to mask the name. What was received is recorded to `secretWrites` so a test can see it —
     * whether the value stays out of the screen (the DOM) is checked separately by a test.
     */
    /** Sharing (#371 part A) — like the host: only an app that exists, the mark in the list, then the broadcast */
    setShared: async (appId: string, projectId: string, shared: boolean): Promise<void> => {
      const a = this.registry.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      if (!a) throw new Error(`No such app: ${appId}`)
      if (shared) a.shared = true
      else delete a.shared
      this.sharedWrites.push({ appId, projectId, shared })
      this.emit({ type: 'external_apps_changed' })
    },
    setSecret: async (appId: string, projectId: string | null, name: string, value: string | null): Promise<void> => {
      const a = this.registry.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      if (!a) throw new Error(`There is no such app: ${projectId ?? 'user'}/${appId}`)
      const slot = a.secrets?.find((s) => s.name === name)
      if (value !== null) {
        if (!slot) throw new Error(`This app does not declare a secret named ${name}`)
        if (value.length === 0) throw new Error('Enter a value, or clear the secret instead')
      }
      this.secretWrites.push({ appId, projectId, name, value })
      if (slot) slot.set = value !== null
      this.emit({ type: 'external_apps_changed' })
    },
  }

  constructor(
    private readonly emit: Emit,
    private readonly registry: AppRegistry,
  ) {}
}
