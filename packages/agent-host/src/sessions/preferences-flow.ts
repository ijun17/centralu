import { DEFAULT_NOTIFY_POLICY, ORCHESTRATOR_CHANGE, TEXT_SIZES, THEME_PRESETS, UiPreferencesPatch, nearestTextSize, type UiPreferences } from '@cc/protocol'
import type { PreferenceChanges, PreferencesRequest } from '../adapters/contract.js'
import type { HostCards } from './host-cards.js'
import { plainQuoted } from './tool-answers.js'
import { callWindow, issuesOf, type WindowRpc } from './window-rpc.js'

export type { PreferencesRequest }

export type PreferencesAnswer = { ok: true; text: string } | { ok: false; error: string }

/** What the preference commands reach of the session manager: its cards */
export type PreferencesFlowHost = Pick<HostCards, 'askHost'>

/** Control and format characters (bidi overrides among them): a line the model reads would not show what they hide */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** A theme the person can pick: a preset, or a theme file that reads cleanly */
type ThemeChoice = { id: string; name: string; base: 'dark' | 'light'; file: boolean }

/** The cards for the update switches (see the comment where they are asked) */
const APPLY_CARD =
  'Turn on "Apply updates automatically when idle"? From then on this computer installs a newer Centralu by itself as soon as one is ' +
  'published, and the desktop window relaunches into it when nothing is busy, without asking again. You can turn it off in Settings, Updates.'
const CHECK_CARD =
  'Turn on checking for updates automatically? "Apply updates automatically when idle" is on, so as soon as a newer Centralu is published ' +
  'this computer installs it by itself and the desktop window relaunches into it when nothing is busy, without asking again. You can turn ' +
  'either off in Settings, Updates.'

const SLEEP_CHOICES = 'a whole number of minutes, or "never"'

/**
 * The orchestrator's preference commands (#1219, second slice): `get_preferences` reads every setting Settings shows,
 * `set_preferences` changes the reversible ones the window offers. Each is the call the window makes (`prefs.set`,
 * `agents.setSleepPolicy`, `updates.setAuto`, ...) through the router, so the host checks it as it checks the window:
 * the method's own schema, and the same handler. What the window keeps for itself, or that widens what agents may do
 * (`sessionTools`, the agent ceiling, depth and models, trust, approval rules), has no field here.
 *
 * Reversible means no card, with one exception: "apply updates when idle" turned **on** asks first, in every preset. With
 * it on, this computer installs a newer Centralu by itself and the window relaunches into it when nothing is busy, so
 * from then on code arrives without a later question; `update_centralu` never touches that switch for the same reason
 * (docs/agent-host.md §4.5). Turning it off, and every other switch, acts at once.
 */
export class PreferencesFlow {
  private rpc: WindowRpc | null = null

  constructor(private readonly host: PreferencesFlowHost) {}

  useRpc(rpc: WindowRpc): void {
    this.rpc = rpc
  }

  async run(sessionId: string, req: PreferencesRequest, signal?: AbortSignal): Promise<PreferencesAnswer> {
    const rpc = this.rpc
    if (!rpc) return { ok: false, error: 'This host has no window calls to make.' }
    try {
      return req.action === 'get' ? await this.get(rpc) : await this.set(rpc, sessionId, req.changes, signal)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Every setting Settings shows, one line each; a part the host cannot read says so, and the rest still answers */
  private async get(rpc: WindowRpc): Promise<PreferencesAnswer> {
    const [prefs, themes, sleep, updates, versions] = await Promise.allSettled([
      callWindow(rpc, 'prefs.get', {}),
      callWindow(rpc, 'themes.list', {}),
      callWindow(rpc, 'agents.sleepPolicy', {}),
      callWindow(rpc, 'updates.status', { force: false }),
      callWindow(rpc, 'agents.versions', { force: false }),
    ])
    if (prefs.status === 'rejected') return { ok: false, error: `Could not read the preferences: ${prefs.reason instanceof Error ? prefs.reason.message : String(prefs.reason)}` }
    const p = prefs.value
    const choices = themes.status === 'fulfilled' ? themeChoices(themes.value) : themeChoices([])
    const named = (id: string) => {
      const c = choices.find((x) => x.id === id)
      return c ? `${plainQuoted(c.name)} [${c.id}]` : `[${plainQuoted(id)}] (no such theme; the stylesheet's own is shown)`
    }
    const notify = p.notifyPolicy ?? DEFAULT_NOTIFY_POLICY
    const lines = [
      'Appearance',
      `- Theme mode: ${p.themeMode}; dark theme ${named(p.themeDark)}; light theme ${named(p.themeLight)}`,
      `- Themes to choose from (set_preferences theme): ${choices.map((c) => `${plainQuoted(c.name)} [${c.id}] (${c.base}${c.file ? ', a theme file' : ''})`).join(', ')}`,
      `- Text size: ${p.textSize} (${TEXT_SIZES.join(', ')}; 1 is the default)`,
      `- Body font: ${p.bodyFont ? plainQuoted(p.bodyFont, 200) : "the app's own"}; code font: ${p.codeFont ? plainQuoted(p.codeFont, 200) : "the app's own"}`,
      `- Line height: ${p.lineHeight} (compact, normal, relaxed)`,
      `- Accent colour: ${p.accent === null ? 'none' : plainQuoted(p.accent, 80)}`,
      'Notifications (set_preferences notifications)',
      `- Approval needed: ${onOff(notify.approval)}; error: ${onOff(notify.error)}; a session finishes out of sight: ${onOff(notify.done)}; every session finished: ${onOff(notify.allDone)}; even while the app is focused: ${onOff(notify.whenFocused)}; sound: ${onOff(notify.sound)}`,
      'Background',
      sleep.status === 'fulfilled'
        ? `- Idle sessions sleep after: ${sleep.value.afterMinutes === null ? 'never' : `${sleep.value.afterMinutes} minutes`} (set_preferences idleSleepMinutes)`
        : '- Idle sleep: not available on this host',
      'Updates',
      updates.status === 'fulfilled'
        ? `- Check for updates automatically: ${onOff(updates.value.auto)} (checkForUpdates); apply updates automatically when idle: ${onOff(updates.value.autoApply)} (applyUpdatesWhenIdle, asks the person to turn on); running ${updates.value.current}${updates.value.latest ? `, latest known ${updates.value.latest}${updates.value.newer ? ' (newer)' : ''}` : ''}`
        : '- Updates: not available on this host',
      versions.status === 'fulfilled'
        ? `- Move idle sessions to a newly installed agent CLI: ${onOff(versions.value.autoApply)} (moveIdleSessionsToNewAgentCli)`
        : '- Agent CLI versions: not available on this host',
      'Kept by the person (no command changes these)',
      `- Send with Ctrl+Enter instead of Enter: ${onOff(p.sendWithModifierEnter)}; Centralu's read-only tools in ordinary sessions: ${onOff(p.sessionTools)}`,
      `- Agents: running per project ${p.agentCeiling === undefined || p.agentCeiling === null ? 'by preset' : p.agentCeiling === 0 ? 'unlimited' : p.agentCeiling}; levels that may start agents ${p.agentDepth ?? 1}`,
    ]
    return { ok: true, text: lines.join('\n') }
  }

  private async set(rpc: WindowRpc, sessionId: string, changes: PreferenceChanges, signal?: AbortSignal): Promise<PreferencesAnswer> {
    // Everything that can be known first is refused before anything changes
    const patch: Record<string, unknown> = {}
    let theme: ThemeChoice | null = null
    if (changes.theme !== undefined) {
      const found = await this.theme(rpc, changes.theme)
      if (typeof found === 'string') return { ok: false, error: found }
      theme = found
      patch.themeMode = found.base
      patch[found.base === 'dark' ? 'themeDark' : 'themeLight'] = found.id
    }
    if (changes.textSize !== undefined) {
      if (!Number.isFinite(changes.textSize)) return { ok: false, error: `textSize is a number: one of ${TEXT_SIZES.join(', ')}.` }
      patch.textSize = nearestTextSize(changes.textSize)
    }
    for (const key of ['bodyFont', 'codeFont'] as const) {
      const value = changes[key]
      if (value === undefined) continue
      if (HIDDEN.test(value)) return { ok: false, error: `${key} has a control or formatting character in it; give a font family as plain text.` }
      patch[key] = value.trim()
    }
    if (changes.lineHeight !== undefined) patch.lineHeight = changes.lineHeight
    const parsed = UiPreferencesPatch.safeParse(patch)
    if (!parsed.success) return { ok: false, error: `Nothing changed: ${issuesOf(parsed.error)}.` }
    const sleep = changes.idleSleepMinutes
    if (sleep !== undefined && sleep !== 'never' && !(Number.isInteger(sleep) && sleep > 0)) {
      return { ok: false, error: `idleSleepMinutes is ${SLEEP_CHOICES}.` }
    }

    const done: string[] = []
    const failed: string[] = []
    const attempt = async (what: string, run: () => Promise<string>) => {
      try {
        done.push(await run())
      } catch (e) {
        failed.push(`${what}: ${(e as Error).message}`)
      }
    }

    if (Object.keys(patch).length) {
      await attempt('Appearance', async () => {
        const now = await callWindow(rpc, 'prefs.set', { patch: parsed.data })
        return appearanceText(now, patch, theme)
      })
    }
    // The notification switches (#1306): only those named change, merged into the host's record one by one
    const switches = Object.fromEntries(Object.entries(changes.notifications ?? {}).filter(([, v]) => v !== undefined))
    if (Object.keys(switches).length) {
      await attempt('Notifications', async () => {
        const now = (await callWindow(rpc, 'prefs.set', { patch: { notifyPolicy: switches } })).notifyPolicy ?? DEFAULT_NOTIFY_POLICY
        return `Now: notifications: approval ${onOff(now.approval)}, error ${onOff(now.error)}, a session finishes out of sight ${onOff(now.done)}, every session finished ${onOff(now.allDone)}, even while focused ${onOff(now.whenFocused)}, sound ${onOff(now.sound)}.`
      })
    }
    if (sleep !== undefined) {
      await attempt('Idle sleep', async () => {
        const now = await callWindow(rpc, 'agents.setSleepPolicy', { afterMinutes: sleep === 'never' ? null : sleep })
        return `Idle sessions sleep after ${now.afterMinutes === null ? 'never' : `${now.afterMinutes} minutes`}.`
      })
    }
    /*
     * The two update switches together. Code arrives unasked once checking and applying are both on, so the card is for the
     * change that makes it so, whichever of the two completes it: apply turned on, or checking turned on while apply is on.
     * Turning either off, or leaving them as they are, asks nothing. (docs/agent-host.md §4.5)
     */
    let checkUpdates = changes.checkForUpdates
    let applyUpdates = changes.applyUpdatesWhenIdle
    if (checkUpdates === true || applyUpdates === true) {
      try {
        const before = await callWindow(rpc, 'updates.status', { force: false })
        const turningApplyOn = applyUpdates === true && !before.autoApply
        const checksComeOn = () => checkUpdates === true && !before.auto && (applyUpdates ?? before.autoApply)
        if (turningApplyOn || checksComeOn()) {
          const refused = await this.ask(sessionId, turningApplyOn ? APPLY_CARD : CHECK_CARD, signal)
          if (refused) {
            failed.push(`${turningApplyOn ? 'Applying updates' : 'Update checks'}: ${refused}`)
            if (turningApplyOn) applyUpdates = undefined
            // With apply left off, checking coming on is no longer the change that lets code arrive unasked
            if (checksComeOn()) checkUpdates = undefined
          }
        }
      } catch (e) {
        failed.push(`Updates: ${(e as Error).message}`)
        if (checkUpdates === true) checkUpdates = undefined
        if (applyUpdates === true) applyUpdates = undefined
      }
    }
    if (checkUpdates !== undefined) {
      const enabled = checkUpdates
      await attempt('Update checks', async () => {
        const now = await callWindow(rpc, 'updates.setAuto', { enabled })
        return `Checking for updates automatically is ${onOff(now.auto)}.`
      })
    }
    if (changes.moveIdleSessionsToNewAgentCli !== undefined) {
      const enabled = changes.moveIdleSessionsToNewAgentCli
      await attempt('Agent CLI versions', async () => {
        const now = await callWindow(rpc, 'agents.setAutoApplyVersions', { enabled })
        return `Moving idle sessions to a newly installed agent CLI is ${onOff(now.autoApply)}.`
      })
    }
    if (applyUpdates !== undefined) {
      const enabled = applyUpdates
      await attempt('Applying updates', async () => {
        const now = await callWindow(rpc, 'updates.setAutoApply', { enabled })
        return `Applying updates automatically when idle is ${onOff(now.autoApply)}.`
      })
    }

    if (!done.length) return { ok: false, error: `Nothing changed. ${failed.join(' ')}` }
    return { ok: true, text: [...done, ...(failed.length ? [`Not changed: ${failed.join(' ')}`] : [])].join('\n') }
  }

  /** The theme the model named, by id or by name, or the sentence that says what it can name instead */
  private async theme(rpc: WindowRpc, ref: string): Promise<ThemeChoice | string> {
    const wanted = ref.trim()
    if (!wanted) return 'theme is empty; get_preferences lists the themes to choose from.'
    if (HIDDEN.test(wanted)) return 'theme has a control or formatting character in it; give its id or name as plain text.'
    const choices = themeChoices(await callWindow(rpc, 'themes.list', {}))
    const byId = choices.find((c) => c.id === wanted.toLowerCase())
    if (byId) return byId
    const byName = choices.filter((c) => c.name.toLowerCase() === wanted.toLowerCase())
    if (byName.length === 1) return byName[0]!
    if (byName.length > 1) return `Several themes are called ${plainQuoted(wanted)}; give one of their ids: ${byName.map((c) => c.id).join(', ')}.`
    return `No theme is called ${plainQuoted(wanted)}. Choose one of: ${choices.map((c) => `${plainQuoted(c.name)} [${c.id}]`).join(', ')}.`
  }

  /** The preferences card, allow or deny only (`ORCHESTRATOR_CHANGE`): the refusal the orchestrator reads, or null once allowed */
  private async ask(sessionId: string, question: string, signal?: AbortSignal): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return 'The person did not approve it, so it stays off. Do not ask again unless they tell you to.'
    if (decision === null) return 'The card was withdrawn before the person answered, so nothing changed.'
    return null
  }
}

const onOff = (on: boolean) => (on ? 'on' : 'off')

/** The presets, then the theme files that read cleanly: what a window's theme list offers */
function themeChoices(files: readonly { id: string; name: string; base: 'dark' | 'light'; broken: boolean }[]): ThemeChoice[] {
  return [
    ...THEME_PRESETS.map((p) => ({ id: p.id, name: p.name, base: p.base, file: false })),
    ...files.filter((f) => !f.broken).map((f) => ({ id: f.id, name: f.name, base: f.base, file: true })),
  ]
}

/** What `prefs.set` left, for the fields this call set: the record the host wrote, not what was asked */
function appearanceText(now: UiPreferences, patch: Record<string, unknown>, theme: ThemeChoice | null): string {
  const parts: string[] = []
  if (theme) {
    const side = theme.base === 'dark' ? now.themeDark : now.themeLight
    parts.push(`theme ${plainQuoted(theme.name)} [${side}] (the ${theme.base} theme, shown now; mode ${now.themeMode})`)
  }
  if ('textSize' in patch) parts.push(`text size ${now.textSize}`)
  if ('bodyFont' in patch) parts.push(`body font ${now.bodyFont ? plainQuoted(now.bodyFont, 200) : "the app's own"}`)
  if ('codeFont' in patch) parts.push(`code font ${now.codeFont ? plainQuoted(now.codeFont, 200) : "the app's own"}`)
  if ('lineHeight' in patch) parts.push(`line height ${now.lineHeight}`)
  return `Now: ${parts.join('; ')}.`
}
