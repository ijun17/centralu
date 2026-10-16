import type { ReadResourceResult } from '@modelcontextprotocol/client'
import { appLabel } from '@cc/protocol'
import type { AppLifecycle } from './app-lifecycle.js'
import { resetLife, type AppEntry, type Blocker } from './app-entry.js'
import { checkScreen, checkTools, formatReport, type AppCheckReport, type CheckFinding, type CheckedTool } from './check.js'
import type { AppRef } from './ref.js'
import type { RuntimeTiming } from './runtime-types.js'

/** What a check asks of the runtime (`ExternalApps.check`) */
export type CheckHost = {
  readonly timing: RuntimeTiming
  readonly lifecycle: AppLifecycle
  /** Reads the app's scope now, a deferred manifest change included (`rescan`'s `now`) */
  rescanNow(ref: AppRef): void
  find(ref: AppRef): AppEntry | undefined
  blocker(e: AppEntry, opts: { fresh?: boolean }): Blocker | null
  appsChanged(): void
}

/** Where a check reports what stops the app from running (`check`) */
const CHECK_WHERE: Record<Blocker['kind'], CheckFinding['where']> = {
  invalid: 'centralu.app.json',
  untrusted: 'trust',
  unconfirmed: 'review',
  removing: 'app',
  failed: 'start',
}

/**
 * Checks an app (M4 C-3) — the body of `ExternalApps.check`, which says what a check does and
 * promises. The findings and the report's shape are `check.ts`.
 */
export async function checkApp(host: CheckHost, ref: AppRef): Promise<AppCheckReport> {
  const label = appLabel(ref)
  const findings: CheckFinding[] = []
  const notes: string[] = []
  let tools: CheckedTool[] = []
  const screens: { uri: string; chars: number }[] = []
  let procLine: string | null = null
  const report = (stderr: string | null) => formatReport(label, { findings, tools, screens }, { process: procLine, notes, stderr })

  host.rescanNow(ref)
  const e = host.find(ref)
  if (!e) {
    findings.push({ level: 'problem', where: 'app', message: 'there is no such app — its folder was removed or renamed' })
    return report(null)
  }
  for (const w of e.warnings) findings.push({ level: 'warning', where: 'centralu.app.json', message: w })
  // A check gives a stopped app another start (see above), so only what a check cannot clear stops it here
  const blocked = host.blocker(e, { fresh: true })
  if (blocked) {
    findings.push({ level: 'problem', where: CHECK_WHERE[blocked.kind], message: blocked.kind === 'invalid' ? (e.error ?? 'the manifest is invalid') : blocked.reason })
    return report(null)
  }

  // Restarts with the current files — stopped in **the very same tick** the call finishes (see the comment on drain)
  let restarted = false
  for (;;) {
    if (e.life.inflight === 0) {
      const wasStopped = e.life.gaveUp
      void host.lifecycle.halt(e, 'check: starting again from the files on disk')
      resetLife(e.life)
      if (wasStopped) host.appsChanged()
      restarted = true
      break
    }
    const busy = e.life.inflight
    if (!(await host.lifecycle.drain(e, host.timing.checkDrainMs))) {
      const limit = host.timing.checkDrainMs >= 1000 ? `${Math.round(host.timing.checkDrainMs / 1000)} s` : `${host.timing.checkDrainMs} ms`
      notes.push(
        `${busy} call${busy === 1 ? ' was' : 's were'} still running after ${limit}, so the app was not restarted — ` +
          'this report is about the process that was already running, which may not have your latest code',
      )
      break
    }
  }

  let stderr: string | null = null
  try {
    await host.lifecycle.use(e, async (proc) => {
      const listed = await proc.client.listTools(undefined, { timeout: host.timing.connectTimeoutMs })
      proc.tools = listed.tools
      host.lifecycle.readTools(e, proc)
      const t = checkTools(e.manifest!, listed.tools)
      findings.push(...t.findings)
      tools = t.tools
      for (const uri of t.screens) {
        let read: ReadResourceResult | Error
        try {
          read = await proc.client.readResource({ uri }, { timeout: host.timing.connectTimeoutMs })
        } catch (err) {
          read = err as Error
        }
        const s = checkScreen(uri, read)
        findings.push(...s.findings)
        screens.push({ uri, chars: s.chars })
      }
      procLine = `pid ${proc.child.pid}, ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()}), ${restarted ? 'restarted from the files on disk' : 'the process that was already running'}`
      stderr = proc.log.tail() || null
    })
  } catch (err) {
    // Failed to start — the reason already includes the tail of stderr (AppProcess.start)
    findings.push({ level: 'problem', where: 'start', message: (err as Error).message })
  }
  return report(stderr)
}
