import { appKeyOf, noSuchAppText, sameApp } from '@cc/protocol/client'
import type { AppPermission, AppUsage, AppQuestion } from '@cc/protocol/client'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'

/** What a person decides about an app: capability questions, remembered permissions, usage, sharing and secrets (M4 D, E) */
export class AppSettingsMock {
  readonly secretWrites: { appId: string; projectId: string | null; name: string; value: string | null }[] = []
  readonly sharedWrites: { appId: string; projectId: string; shared: boolean }[] = []
  /** Set up with `askAppQuestion`; an answer resolves the waiting side, so "answering resumes the screen's call" is real */
  appQuestionList: AppQuestion[] = []
  readonly answeredQuestions: { questionId: string; decision: 'allow' | 'deny' }[] = []
  private questionWaiters = new Map<string, (d: 'allow' | 'deny') => void>()
  readonly appPermissions = new Map<string, AppPermission[]>()
  readonly appUsage = new Map<string, AppUsage>()
  readonly forgottenPermissions: { appId: string; projectId: string | null; capability: string }[] = []
  /** Resolves once an answer arrives */
  askAppQuestion(q: AppQuestion): Promise<'allow' | 'deny'> {
    this.appQuestionList.push(structuredClone(q))
    this.emit({ type: 'external_app_questions_changed' })
    return new Promise((resolve) => this.questionWaiters.set(q.id, resolve))
  }
  readonly apps = {
    // As the host: an answer removes it and broadcasts; a closed question is rejected
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
    // Absent is 0, as on the host
    usage: async (appId: string, projectId: string | null): Promise<AppUsage> =>
      structuredClone(
        this.appUsage.get(appKeyOf(projectId, appId)) ?? {
          day: { runs: 0, durationMs: 0, tokens: null },
          month: { runs: 0, durationMs: 0, tokens: null },
        },
      ),
    /** As `ExternalApps.updateSecret`: declared names only, an empty value refused, the list says only present/absent */
    /** As the host (#371): only an app that exists */
    setShared: async (appId: string, projectId: string, shared: boolean): Promise<void> => {
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId }))
      if (!a) throw new Error(`No such app: ${appId}`)
      if (shared) a.shared = true
      else delete a.shared
      this.sharedWrites.push({ appId, projectId, shared })
      this.emit({ type: 'external_apps_changed' })
    },
    /** As the host (#1938): a project app only, marked `stopped` */
    setOff: async (appId: string, projectId: string, off: boolean): Promise<void> => {
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId }))
      if (!a) throw new Error(`No such app: ${appId}`)
      if (off) Object.assign(a, { off: true, status: 'stopped' })
      else delete a.off
      this.emit({ type: 'external_apps_changed' })
    },
    setSecret: async (appId: string, projectId: string | null, name: string, value: string | null, machine?: string): Promise<void> => {
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId, machine }))
      if (!a) throw new Error(noSuchAppText({ projectId, appId }))
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
