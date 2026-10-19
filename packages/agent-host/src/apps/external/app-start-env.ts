import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { USER_APP_SCOPE as USER_SCOPE, type ExternalAppInfo } from '@cc/protocol'
import type { AppCalls } from './app-calls.js'
import type { AppEntry } from './app-entry.js'
import type { AppLifecycle } from './app-lifecycle.js'
import type { SpawnSpec } from './app-process.js'
import { serveBroker } from './broker.js'
import type { BrokerDesk } from './desk.js'
import type { AppRef } from './ref.js'
import type { ExternalAppsDeps, RuntimeTiming } from './runtime-types.js'
import { redactor, type Redact, type SecretStore } from './secrets.js'
import { AppUnavailableError } from './unavailable.js'

/**
 * What an app process is started with (runtime.ts): its folder, its data folder outside the
 * repository, the secrets its manifest declared and an environment without the host's own
 * variables, and where its secrets are masked. `ExternalApps` holds one and reaches the rest of the
 * runtime only through what it hands in here
 */
export class AppStartEnv {
  constructor(
    private readonly deps: Pick<ExternalAppsDeps, 'dataRoot' | 'env'>,
    private readonly timing: RuntimeTiming,
    private readonly secrets: SecretStore,
    private readonly calls: Pick<AppCalls, 'openRuns'>,
    private readonly desk: Pick<BrokerDesk, 'refused' | 'handle'>,
    private readonly lifecycle: Pick<AppLifecycle, 'setBusy'>,
  ) {}

  /**
   * The shape to start with. What the app receives:
   *   - cwd = the app folder
   *   - `CENTRALU_APP_DATA` = a data folder outside the repository (created if it does not exist).
   *     Writing this inside the app folder would get it committed and leaked to the team (from the
   *     plan, "data and secrets")
   *   - only the secrets the manifest **declared**, as environment variables
   * What it never receives: the host's own variables (`CC_*`). Among them is the host's WebSocket
   * token (`CC_HOST_TOKEN`) — handing that to an app would let it call every one of the host's RPCs.
   */
  spawnSpec(e: AppEntry, pipeId: number): SpawnSpec {
    const m = e.manifest!
    const scopeDir = this.scopeDir(e.ref)
    const dataDir = this.dataDirOf(e.ref)
    mkdirSync(dataDir, { recursive: true })
    const appKey = this.appKey(e.ref)
    const secrets = this.secrets.forApp(appKey, m.secrets ?? [])
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) {
      if (k.startsWith('CC_') || k.startsWith('CENTRALU_')) continue
      env[k] = v
    }
    Object.assign(env, secrets, { CENTRALU_APP_ID: e.ref.appId, CENTRALU_APP_DATA: dataDir })
    return {
      command: m.server.command,
      args: m.server.args,
      cwd: e.dir,
      env,
      logPath: join(this.deps.dataRoot, 'app-logs', scopeDir, `${e.ref.appId}.log`),
      logMaxBytes: this.timing.logMaxBytes,
      // Masks every stored value, even one absent from the declaration — masking it costs nothing
      redact: this.masker(e.ref),
      prior: e.life.verdict,
      probeTimeoutMs: this.timing.probeTimeoutMs,
      connectTimeoutMs: this.timing.connectTimeoutMs,
      exitWaitMs: this.timing.startExitWaitMs,
      serveFd3: (fd3, note) =>
        serveBroker(
          fd3,
          {
            // Only this pipe's app, and a run open on this pipe — someone else's id and a dead process's id both fail
            openRun: (runId) => {
              const run = this.calls.openRuns.get(runId)
              return run && run.entry === e && run.pipeId === pipeId ? run.abort.signal : null
            },
            note,
            // Its own state, on its own pipe: whether this process is the app's current one is the lifecycle's to say (#1236)
            busy: (reason) => this.lifecycle.setBusy(e, pipeId, reason),
            refused: (tool, args, why) => this.desk.refused({ ref: e.ref, name: m.name, manifest: m }, tool, args, why),
          },
          /*
           * The requesting app is this pipe's app, and the manifest is **the one read when this process
           * started.** If the manifest changed in the meantime, a new entry was created and this process
           * stops after finishing its call — while it is still running, it requests things under the
           * declaration it started with (what was validated is what is used).
           */
          (tool, args, call) => this.desk.handle({ ref: e.ref, name: m.name, manifest: m }, tool, args, call),
          { keepaliveMs: this.timing.brokerKeepaliveMs },
        ),
    }
  }

  /** An app's data folder — outside the app folder (from the plan, "data and secrets"). The app receives it as `CENTRALU_APP_DATA` */
  dataDirOf(ref: AppRef): string {
    return join(this.deps.dataRoot, 'app-data', this.scopeDir(ref), ref.appId)
  }

  /** The scope name used as one path segment. A project id is a UUID — refused rather than written into a path if it does not look like one */
  private scopeDir(ref: AppRef): string {
    if (ref.projectId === null) return USER_SCOPE
    if (!/^[A-Za-z0-9-]+$/.test(ref.projectId)) throw new AppUnavailableError(`This project id cannot be used in a path: ${ref.projectId}`)
    return ref.projectId
  }

  /**
   * The function that masks every secret stored for this app (A-3, A-6) — whichever of a run's
   * arguments, its result, its failure reason or the app's own log a value ends up mixed into, only
   * its name survives. Built from the stored values at the moment it is asked for: a tool call's row,
   * a broker request's row and a starting process each take their own.
   */
  masker(ref: AppRef): Redact {
    return redactor(this.secrets.all(this.appKey(ref)))
  }

  appKey(ref: AppRef): string {
    return `${this.scopeDir(ref)}/${ref.appId}`
  }

  /** Whether a value is set for each declared secret (E, the secrets section) — just the name and whether it is set. No field at all if there is no declaration */
  secretSlots(e: AppEntry): Pick<ExternalAppInfo, 'secrets' | 'secretsUnreadable'> {
    const declared = e.manifest?.secrets ?? []
    if (declared.length === 0) return {}
    const stored = this.secrets.names(this.appKey(e.ref))
    // This app's: one app's value entered again says nothing of another's (#944, #993 review)
    const trouble = this.secrets.trouble(this.appKey(e.ref))
    return { secrets: declared.map((name) => ({ name, set: stored.has(name) })), ...(trouble ? { secretsUnreadable: trouble } : {}) }
  }
}
