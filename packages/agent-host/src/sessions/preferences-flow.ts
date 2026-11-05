import { DEFAULT_NOTIFY_POLICY, ORCHESTRATOR_CHANGE, errorMessage, SessionId, THEME_TOKENS, ThemeFileContent, formatThemeFile, ThemeId, type ThemeFileEntry, autoCompactOf, nudgeShares, listedModel, type AutoCompact, type ModelOption, TEXT_SIZES, THEME_PRESETS, UiPreferencesPatch, nearestTextSize, type UiPreferences, type UpdateStatus } from '@cc/protocol'
import { themeSlug } from '../themes.js'
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

/** The card for turning automatic updates on (see the comment where it is asked) */
const UPDATE_CARD =
  'Turn on "Automatic updates"? From then on this computer checks for a newer Centralu, installs it by itself as soon as one is published, ' +
  'and the desktop window relaunches into it when nothing is busy, without asking again. You can turn it off in Settings, Updates.'

/** The reader refuses a theme file bigger than this (themes.ts) */
const THEME_FILE_MAX_BYTES = 256 * 1024

/** The most groups `UiPreferences.foldedGroups` holds (the window drops the oldest fold past it) */
const FOLDED_GROUPS_MAX = 500

const SLEEP_CHOICES = 'a whole number of minutes, or "never"'

/** The setting in a line */
function autoCompactText(c: AutoCompact): string {
  if (!c.controlled) return "Centralu does not set when agents compact; each agent's own settings decide"
  const n = nudgeShares(c)
  const nudge = c.nudge ? `a session is told quietly to call compact_self at ${Math.round(n.first * 100)}% and ${Math.round(n.second * 100)}%` : 'a session is not told to call compact_self'
  return `agents compact at ${Math.round(c.share * 100)}% of the model's window, set by Centralu; a session at rest is compacted over ${Math.round(c.idleShare * 100)}%; ${nudge}`
}

/**
 * The orchestrator's preference commands (#1219, second slice): `get_preferences` reads every setting Settings shows,
 * `set_preferences` changes the reversible ones the window offers. Each is the call the window makes (`prefs.set`,
 * `agents.setSleepPolicy`, `updates.setAuto`, ...) through the router, so the host checks it as it checks the window:
 * the method's own schema, and the same handler. What the window keeps for itself, or that widens what agents may do
 * (the agent ceiling, depth and models, trust, approval rules), has no field here: the trust commands (`trust-flow.ts`)
 * change trust, rules, grants and the limits on agents, each behind its own card where it widens. "Let sessions look at
 * other sessions" (`sessionTools`) is not a setting any more (owner decision 2026-10-20): always on, so neither command
 * names it.
 *
 * Reversible means no card, with two exceptions. Turning off the notification for an approval asks first (the one that
 * tells the person a card waits), and so does the sound while it still notifies. The "error" and "every session finished"
 * notifications are gone from the product (owner decision 2026-10-20): the window no longer raises them, so neither command
 * names them, and their stored switches stay readable for older builds. And "Automatic updates" turned **on** asks first,
 * in every preset. With it on, this computer installs a newer Centralu by itself and the window relaunches into it when nothing is busy, so
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
      if (req.action === 'get') return await this.get(rpc, req.themeFile)
      if (req.action === 'apply_agent_versions') return await this.applyVersions(rpc)
      return await this.set(rpc, sessionId, req.changes, signal)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Every setting Settings shows, one line each; a part the host cannot read says so, and the rest still answers */
  private async get(rpc: WindowRpc, themeFile?: string): Promise<PreferencesAnswer> {
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
      ...(themes.status === 'fulfilled' ? themeFileLines(themes.value, themeFile) : []),
      `- Text size: ${p.textSize} (${TEXT_SIZES.join(', ')}; 1 is the default)`,
      `- Body font: ${p.bodyFont ? plainQuoted(p.bodyFont, 200) : "the app's own"}; code font: ${p.codeFont ? plainQuoted(p.codeFont, 200) : "the app's own"}`,
      `- Line height: ${p.lineHeight} (compact, normal, relaxed)`,
      `- Models for the agents a session starts (set_preferences agentModels): ${agentModelsText(p.agentModels)}`,
      'Notifications (set_preferences notifications)',
      `- Approval needed: ${onOff(notify.approval)}; a session finishes out of sight: ${onOff(notify.done)}; even while the app is focused: ${onOff(notify.whenFocused)}; sound: ${onOff(notify.sound)}; turning the approval one off, or the sound while it notifies, asks the person`,
      'Auto compact (set_preferences autoCompact)',
      `- ${autoCompactText(autoCompactOf(p))}`,
      'Background',
      sleep.status === 'fulfilled'
        ? `- Idle sessions sleep after: ${sleep.value.afterMinutes === null ? 'never' : `${sleep.value.afterMinutes} minutes`} (set_preferences idleSleepMinutes)`
        : '- Idle sleep: not available on this host',
      'Updates',
      updates.status === 'fulfilled'
        ? `- Automatic updates (check, install, and apply when idle): ${automatic(updates.value)} (autoUpdate, asks the person to turn on); running ${updates.value.current}${updates.value.latest ? `, latest known ${updates.value.latest}${updates.value.newer ? ' (newer)' : ''}` : ''}`
        : '- Updates: not available on this host',
      versions.status === 'fulfilled'
        ? `- Move idle sessions to a newly installed agent CLI: ${onOff(versions.value.autoApply)} (moveIdleSessionsToNewAgentCli)`
        : '- Agent CLI versions: not available on this host',
      'Interface',
      `- Send with Ctrl+Enter instead of Enter: ${onOff(p.sendWithModifierEnter)} (set_preferences sendWithModifierEnter)`,
      `- Sidebar groups folded: ${p.foldedGroups.length} (set_preferences foldedGroups folds or unfolds a session's children)`,
      'Limits on agents (set_agent_limits changes them, behind the person\'s card)',
      `- Agents: running per project ${p.agentCeiling === undefined || p.agentCeiling === null ? 'by preset' : p.agentCeiling === 0 ? 'unlimited' : p.agentCeiling}; levels that may start agents ${p.agentDepth ?? 1}`,
    ]
    return { ok: true, text: lines.join('\n') }
  }

  private async set(rpc: WindowRpc, sessionId: string, changes: PreferenceChanges, signal?: AbortSignal): Promise<PreferencesAnswer> {
    // Everything that can be known first is refused before anything changes
    const patch: Record<string, unknown> = {}
    let theme: ThemeChoice | null = null
    const done: string[] = []
    const failed: string[] = []
    const modelWarnings: string[] = []
    /*
     * Every check comes first and the theme file is written last, so a refused call leaves nothing behind. A theme named in
     * the same call as the file that makes it cannot be looked up yet: it is looked up after the write (a miss then is a
     * partial success, said so).
     */
    const file = changes.themeFile
    if (file !== undefined) {
      const bad = themeFileRefusal(file)
      if (bad) return { ok: false, error: bad }
    }
    if (changes.theme !== undefined) {
      const found = await this.theme(rpc, changes.theme)
      const wanted = changes.theme.trim().toLowerCase()
      const madeHere = file !== undefined && (file.name.trim().toLowerCase() === wanted || (await this.idOfFile(rpc, file)) === wanted)
      if (typeof found === 'string' && !madeHere) return { ok: false, error: found }
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
    if (changes.agentModels !== undefined) {
      const merged = await this.mergedAgentModels(rpc, changes.agentModels)
      if (typeof merged === 'string') return { ok: false, error: merged }
      patch.agentModels = merged.models
      modelWarnings.push(...merged.warnings)
    }
    if (changes.lineHeight !== undefined) patch.lineHeight = changes.lineHeight
    if (changes.sendWithModifierEnter !== undefined) patch.sendWithModifierEnter = changes.sendWithModifierEnter
    if (changes.foldedGroups !== undefined) {
      const keys = await this.foldedKeys(rpc, changes.foldedGroups)
      if (typeof keys === 'string') return { ok: false, error: keys }
      patch.foldedGroups = keys
    }
    const parsed = UiPreferencesPatch.safeParse(patch)
    if (!parsed.success) return { ok: false, error: `${issuesOf(parsed.error)}.` }
    const sleep = changes.idleSleepMinutes
    if (sleep !== undefined && sleep !== 'never' && !(Number.isInteger(sleep) && sleep > 0)) {
      return { ok: false, error: `idleSleepMinutes is ${SLEEP_CHOICES}.` }
    }

    if (file !== undefined) {
      try {
        const saved = await callWindow(rpc, 'themes.save', { id: file.id?.trim() || null, content: { name: file.name.trim(), base: file.base, tokens: file.tokens } })
        done.push(themeFileWritten(saved))
      } catch (e) {
        return { ok: false, error: errorMessage(e) }
      }
    }
    let toApply = parsed.data
    if (changes.theme !== undefined) {
      const found = await this.theme(rpc, changes.theme)
      if (typeof found === 'string') failed.push(`Theme: not picked. ${found}`)
      else {
        theme = found
        patch.themeMode = found.base
        patch[found.base === 'dark' ? 'themeDark' : 'themeLight'] = found.id
        const again = UiPreferencesPatch.safeParse(patch)
        if (again.success) toApply = again.data
        else {
          // After the write this is a partial success, not a refusal
          theme = null
          failed.push(`Theme: not picked. ${issuesOf(again.error)}.`)
        }
      }
    }

    const attempt = async (what: string, run: () => Promise<string>) => {
      try {
        done.push(await run())
      } catch (e) {
        failed.push(`${what}: ${(e as Error).message}`)
      }
    }

    if (Object.keys(patch).length) {
      await attempt('Appearance', async () => {
        const now = await callWindow(rpc, 'prefs.set', { patch: toApply })
        return [appearanceText(now, patch, theme), ...modelWarnings].join(' ')
      })
    }
    // The notification switches (#1306): only those named change, merged into the host's record one by one
    const switches: Record<string, boolean> = Object.fromEntries(Object.entries(changes.notifications ?? {}).filter(([, v]) => v !== undefined))
    /*
     * Turning off what tells the person a card waits asks first: the orchestrator would be choosing what the person stops
     * hearing about. That is the notification for an approval, and the sound, which is how it reaches someone who is away
     * (notices.ts alerts through the sound; the OS banner path does not reach them), so turning the sound off counts while an
     * approval would still notify. Turning them on, and every other switch, asks nothing. A denial keeps them as they were,
     * and the other switches of the call still change. A switch already off is no change.
     */
    if (switches.approval === false || switches.sound === false) {
      let current: Partial<Record<'approval' | 'sound', boolean>> = {}
      try {
        current = (await callWindow(rpc, 'prefs.get', {})).notifyPolicy ?? DEFAULT_NOTIFY_POLICY
      } catch {
        /* unread: treated as on, so it asks */
      }
      // One already off needs no write, and none is made: nothing the card did not name goes out after it
      const turning = switches.approval === false && current.approval !== false
      if (switches.approval === false && !turning) delete switches.approval
      const muting = switches.sound === false && current.sound !== false
      if (switches.sound === false && !muting) delete switches.sound
      // The sound counts while an approval notifies now: off with it in one call, the card names both
      const silences = muting && current.approval !== false
      if (turning || silences) {
        const stop = turning
          ? 'Stop the "awaiting approval" notification? Centralu would no longer show a notice or play a sound when an agent waits for your approval, ' +
            'so an approval could go unnoticed while you are away. You can turn it back on in Settings, Notifications.'
          : ''
        const sound = silences
          ? turning
            ? ' The sound is also turned off, and the sound is how an approval reaches you when you are away.'
            : 'Turn off the notification sound? The sound is how an approval reaches you when you are away; without it an approval shows a notice only, which you may not see. You can turn it back on in Settings, Notifications.'
          : ''
        const refused = await this.ask(sessionId, stop + sound, signal, turning && silences ? 'the approval notification and the sound stay on' : turning ? 'it keeps notifying' : 'the sound stays on')
        if (refused) {
          failed.push(`Notifications: ${refused}`)
          delete switches.approval
          // With an approval still notifying, the sound stays on too: off, it would silence it
          if (silences) delete switches.sound
        }
      }
      // An approval no longer notifies: the sound goes off with nothing to silence, and nothing asks
    }
    if (Object.keys(switches).length) {
      await attempt('Notifications', async () => {
        const now = (await callWindow(rpc, 'prefs.set', { patch: { notifyPolicy: switches } })).notifyPolicy ?? DEFAULT_NOTIFY_POLICY
        return `Now: notifications: approval ${onOff(now.approval)}, a session finishes out of sight ${onOff(now.done)}, even while focused ${onOff(now.whenFocused)}, sound ${onOff(now.sound)}.`
      })
    }
    // When agents compact (#1376): reversible and only theirs to read, so no card; applies to a session's next process start
    const compact = Object.fromEntries(Object.entries(changes.autoCompact ?? {}).filter(([, v]) => v !== undefined))
    if (Object.keys(compact).length) {
      await attempt('Auto compact', async () => {
        const checked = UiPreferencesPatch.safeParse({ autoCompact: compact })
        if (!checked.success) throw new Error(`${issuesOf(checked.error)}.`)
        const now = autoCompactOf(await callWindow(rpc, 'prefs.set', { patch: checked.data }))
        return `Now: ${autoCompactText(now)}. It reaches a running session when its process next starts.`
      })
    }
    if (sleep !== undefined) {
      await attempt('Idle sleep', async () => {
        const now = await callWindow(rpc, 'agents.setSleepPolicy', { afterMinutes: sleep === 'never' ? null : sleep })
        return `Idle sessions sleep after ${now.afterMinutes === null ? 'never' : `${now.afterMinutes} minutes`}.`
      })
    }
    /*
     * "Automatic updates" (owner decision 2026-10-20): one setting over the two stored switches, checking (`updates.setAuto`)
     * and installing and applying when idle (`updates.setAutoApply`). Code arrives unasked once both are on, so turning it on
     * asks unless both are on already (unread counts as off, so it asks). Turning it off asks nothing, and turns installing
     * off first, so a check landing between the two calls installs nothing. Both setters are called either way (each does
     * nothing when already so): a card may stand for minutes, and what was read before it may have changed. Checking goes on
     * first, so its check finds the release before installing is on to take it. (docs/agent-host.md §4.5)
     */
    if (changes.autoUpdate !== undefined) {
      const on = changes.autoUpdate
      let go = true
      if (on) {
        let both = false
        try {
          const before = await callWindow(rpc, 'updates.status', { force: false })
          both = before.auto && before.autoApply
        } catch {
          /* unread: asked as if off */
        }
        if (both) {
          done.push('Automatic updates are on.')
          go = false
        } else {
          const refused = await this.ask(sessionId, UPDATE_CARD, signal)
          if (refused) {
            failed.push(`Automatic updates: ${refused}`)
            go = false
          }
        }
      }
      if (go) {
        const steps: ['updates.setAuto' | 'updates.setAutoApply', boolean][] = on
          ? [['updates.setAuto', true], ['updates.setAutoApply', true]]
          : [['updates.setAutoApply', false], ['updates.setAuto', false]]
        try {
          let now: UpdateStatus | null = null
          for (const [method, enabled] of steps) now = await callWindow(rpc, method, { enabled })
          done.push(`Automatic updates are ${automatic(now!)}.`)
        } catch (e) {
          // Halfway is a change too: say which half is on now, when that can be read
          const now = await callWindow(rpc, 'updates.status', { force: false }).catch(() => null)
          if (now) done.push(`Automatic updates are now ${automatic(now)}.`)
          failed.push(`Automatic updates: ${(e as Error).message}`)
        }
      }
    }
    if (changes.moveIdleSessionsToNewAgentCli !== undefined) {
      const enabled = changes.moveIdleSessionsToNewAgentCli
      await attempt('Agent CLI versions', async () => {
        const now = await callWindow(rpc, 'agents.setAutoApplyVersions', { enabled })
        return `Moving idle sessions to a newly installed agent CLI is ${onOff(now.autoApply)}.`
      })
    }

    if (changes.deleteThemeFile !== undefined) {
      const id = changes.deleteThemeFile.trim()
      await attempt('Theme file', async () => {
        if (!ThemeId.safeParse(id).success) throw new Error(`${plainQuoted(id)} is not a theme file id; get_preferences lists them.`)
        const { removed, keptAt } = await callWindow(rpc, 'themes.remove', { id })
        if (!removed) throw new Error(`No theme file [${id}]; get_preferences lists them.`)
        // A side that showed it goes back to its preset, as Settings does
        const now = await callWindow(rpc, 'prefs.get', {})
        const back: Record<string, string> = {}
        if (now.themeDark === id) back.themeDark = 'dark'
        if (now.themeLight === id) back.themeLight = 'light'
        if (Object.keys(back).length) await callWindow(rpc, 'prefs.set', { patch: back })
        return `Removed the theme file [${id}]; it is kept at ${plainQuoted(keptAt ?? '', 300)} (move it back to restore it).${Object.keys(back).length ? ' A side that showed it is back on its preset.' : ''}`
      })
    }

    if (!done.length) return { ok: false, error: failed.join(' ') }
    return { ok: true, text: [...done, ...(failed.length ? [`Not changed: ${failed.join(' ')}`] : [])].join('\n') }
  }

  /**
   * The folded groups after this change: the window's list as it is now, less the unfolded sessions' groups, with the
   * folded ones last (the oldest fold is dropped past the cap, as the window drops it). The patch carries the whole list, since
   * a list cannot be patched by one entry. Or the sentence that says what is wrong with an id
   */
  private async foldedKeys(rpc: WindowRpc, change: { fold?: string[]; unfold?: string[] }): Promise<string[] | string> {
    const keyOf = (id: string): string | null => {
      const ok = SessionId.safeParse(id.trim())
      return ok.success ? `session:${ok.data}` : null
    }
    const fold = (change.fold ?? []).map((id) => [id, keyOf(id)] as const)
    const unfold = (change.unfold ?? []).map((id) => [id, keyOf(id)] as const)
    const bad = [...fold, ...unfold].find(([, key]) => key === null)
    if (bad) return `${plainQuoted(bad[0])} is not a session id; list_sessions names them.`
    const drop = new Set(unfold.map(([, key]) => key))
    const add = fold.flatMap(([, key]) => (key === null ? [] : [key]))
    const now = (await callWindow(rpc, 'prefs.get', {})).foldedGroups
    const kept = now.filter((key) => !drop.has(key) && !add.includes(key))
    return [...kept, ...add].slice(-FOLDED_GROUPS_MAX)
  }

  /**
   * The saved models with this call's changes merged in (the patch carries the whole map), or the sentence that says what is
   * wrong. The map steers every difficulty-based start_agent in every project, so the tool must be an agent CLI on this
   * computer. A model or effort is free text, as Settings' picker takes with "Other…", also when the tool lists its models
   * (a newer id may not be in the list yet); one the list lacks is saved as typed and said so in a warning. Clearing a
   * difficulty that was never set changes nothing and leaves no empty entry.
   */
  private async mergedAgentModels(rpc: WindowRpc, change: NonNullable<PreferenceChanges['agentModels']>): Promise<{ models: Record<string, Record<string, unknown>>; warnings: string[] } | string> {
    const now = (await callWindow(rpc, 'prefs.get', {})).agentModels ?? {}
    const known = (await callWindow(rpc, 'agents.detect', {})).map((s) => s.name)
    const out: Record<string, Record<string, unknown>> = { ...now }
    const warnings: string[] = []
    for (const [tool, levels] of Object.entries(change)) {
      if (!known.includes(tool)) return `agentModels: ${plainQuoted(tool, 80)} is not an agent CLI on this computer; agent_status lists them (${known.join(', ') || 'none'}).`
      const own: Record<string, unknown> = { ...out[tool] }
      let catalog: ModelOption[] | null | undefined
      for (const [level, choice] of Object.entries(levels)) {
        if (choice === null) delete own[level]
        else if (choice !== undefined) {
          const model = choice.model.trim()
          const effort = choice.effort?.trim()
          if (!model) return 'agentModels: a model is empty; give its id as plain text.'
          if (HIDDEN.test(model) || HIDDEN.test(effort ?? '')) return 'agentModels has a control or formatting character in a model or effort; give plain text.'
          if (catalog === undefined) {
            const r = await callWindow(rpc, 'agents.models', { tool }).catch(() => null)
            catalog = r?.supported && r.models.length ? r.models : null
          }
          if (catalog) {
            const m = listedModel(catalog, model)
            if (!m) warnings.push(`Note: ${plainQuoted(model, 200)} is not in ${tool}'s current list (agent_models); saved as typed.`)
            else if (effort && m.efforts.length && !m.efforts.includes(effort)) warnings.push(`Note: ${plainQuoted(effort, 80)} is not in the current efforts of ${plainQuoted(model, 200)} (${m.efforts.map((e) => plainQuoted(e, 40)).join(', ')}); saved as typed.`)
          }
          own[level] = effort ? { model, effort } : { model }
        }
      }
      if (Object.keys(own).length) out[tool] = own
      else delete out[tool]
    }
    return { models: out, warnings }
  }

  /** The id a theme file will be written under: the one named, else the one `themes.save` files its name under among the ids taken now */
  private async idOfFile(rpc: WindowRpc, file: NonNullable<PreferenceChanges['themeFile']>): Promise<string> {
    const named = file.id?.trim().toLowerCase()
    if (named) return named
    const taken = new Set((await callWindow(rpc, 'themes.list', {})).map((f) => f.id))
    const base = themeSlug(file.name.trim())
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (!taken.has(id)) return id
    }
    return base
  }

  /** The session header's action: idle sessions on an older agent CLI restart on the installed one, and the busy ones are named */
  private async applyVersions(rpc: WindowRpc): Promise<PreferencesAnswer> {
    // An agent asks, not the person's own button: a session that spoke within the last minute keeps its turn (the window's button waits for nothing)
    const r = await callWindow(rpc, 'agents.applyVersions', { keepQuiet: true })
    if (!r.restarted.length && !r.busy.length) return { ok: true, text: 'No session that has been quiet for a minute runs an older agent CLI than the one installed; nothing was restarted.' }
    const busy = r.busy.length ? ` ${r.busy.length === 1 ? '1 session is' : `${r.busy.length} sessions are`} busy and left as ${r.busy.length === 1 ? 'it is' : 'they are'} (${r.busy.join(', ')}); with "Move idle sessions to a newly installed agent CLI" on they move once idle.` : ''
    return { ok: true, text: `Restarted ${r.restarted.length === 1 ? '1 idle session' : `${r.restarted.length} idle sessions`} on the installed agent CLI${r.restarted.length ? ` (${r.restarted.join(', ')})` : ''}.${busy}` }
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
  private async ask(sessionId: string, question: string, signal?: AbortSignal, stays = 'it stays off'): Promise<string | null> {
    const decision = await this.host.askHost(sessionId, { kind: 'other', about: ORCHESTRATOR_CHANGE, raw: question }, signal, { alwaysAsk: true })
    if (decision === 'deny') return `The person did not approve it, so ${stays}. Do not ask again unless they tell you to.`
    if (decision === null) return 'The card was withdrawn before the person answered, so that change was not made.'
    return null
  }
}

const onOff = (on: boolean) => (on ? 'on' : 'off')

/** "Automatic updates" as Settings shows it: on when checking and applying both are, and which half is on otherwise */
function automatic(s: Pick<UpdateStatus, 'auto' | 'autoApply'>): string {
  if (s.auto && s.autoApply) return 'on'
  if (!s.auto && !s.autoApply) return 'off'
  return s.auto ? 'off (checking is on, installing is off)' : 'off (installing is on, checking is off)'
}

/** Why a theme file to write is refused before anything is written, or null: the rules of `themes.save` (its params), and plain text */
function themeFileRefusal(file: NonNullable<PreferenceChanges['themeFile']>): string | null {
  if (file.id !== undefined && file.id.trim() && !ThemeId.safeParse(file.id.trim()).success) {
    return `themeFile.id ${plainQuoted(file.id)} is not a theme id: lowercase letters, digits and dashes, up to 60. Leave it out for a new file.`
  }
  const content = ThemeFileContent.safeParse({ name: file.name.trim(), base: file.base, tokens: file.tokens })
  if (!content.success) return `themeFile: ${issuesOf(content.error)}.`
  if (HIDDEN.test(file.name) || Object.entries(file.tokens).some(([k, v]) => HIDDEN.test(k) || HIDDEN.test(v))) {
    return 'themeFile has a control or formatting character in its name or tokens; give plain text.'
  }
  if (Buffer.byteLength(formatThemeFile(content.data)) > THEME_FILE_MAX_BYTES) return 'themeFile is too large to be a theme file; leave out the tokens you do not change.'
  return null
}

/** What a saved theme file came to: its place, and what the reader will skip of it */
function themeFileWritten(f: ThemeFileEntry): string {
  const problems = f.problems.length ? ` Problems the reader found, skipped when applied: ${f.problems.map((x) => plainQuoted(x, 200)).join(' ')}` : ''
  return `Wrote the theme file ${plainQuoted(f.name)} [${f.id}] (${f.base}, ${Object.keys(f.tokens).length} tokens).${problems}`
}

/** The theme files in get_preferences: a line for all, and one in full when asked for */
function themeFileLines(files: readonly ThemeFileEntry[], one?: string): string[] {
  const state = (f: ThemeFileEntry) => (f.broken ? ', unreadable' : f.problems.length ? `, ${f.problems.length} problems` : '')
  const lines = [
    files.length
      ? `- Theme files (set_preferences themeFile writes one, deleteThemeFile removes one): ${files.map((f) => `${plainQuoted(f.name)} [${f.id}] (${f.base}, ${Object.keys(f.tokens).length} tokens${state(f)})`).join(', ')}`
      : '- Theme files: none (set_preferences themeFile writes one)',
  ]
  if (one) {
    const f = files.find((x) => x.id === one.trim())
    if (!f) lines.push(`- Theme file ${plainQuoted(one)}: no such file`)
    else {
      lines.push(`- Theme file ${plainQuoted(f.name)} [${f.id}], ${f.base}${f.problems.length ? `; problems: ${f.problems.map((x) => plainQuoted(x, 200)).join(' ')}` : ''}`)
      lines.push(...Object.entries(f.tokens).map(([k, v]) => `  ${k}: ${plainQuoted(v, 400)}`))
      lines.push(`  Token keys to set: ${THEME_TOKENS.map((t) => t.key).join(', ')}`)
    }
  }
  return lines
}

/** The models chosen for started agents, in a line */
function agentModelsText(models: UiPreferences['agentModels']): string {
  const parts = Object.entries(models ?? {}).flatMap(([tool, levels]) =>
    Object.entries(levels).flatMap(([level, c]) => (c ? [`${plainQuoted(tool, 80)} ${level}: ${plainQuoted(c.model, 200)}${c.effort ? ` (${plainQuoted(c.effort, 80)})` : ''}`] : [])),
  )
  return parts.length ? parts.join('; ') : 'none chosen (each project keeps its last choice)'
}

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
  if ('sendWithModifierEnter' in patch) parts.push(`send with ${now.sendWithModifierEnter ? 'Ctrl+Enter (Enter breaks the line)' : 'Enter'}`)
  if ('agentModels' in patch) parts.push(`models for started agents: ${agentModelsText(now.agentModels)}`)
  if ('foldedGroups' in patch) parts.push(`${now.foldedGroups.length} sidebar ${now.foldedGroups.length === 1 ? 'group' : 'groups'} folded`)
  return `Now: ${parts.join('; ')}.`
}
