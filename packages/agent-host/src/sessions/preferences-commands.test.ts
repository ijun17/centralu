import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, type AgentVersions, type SleepPolicy, type ToolName, type UpdateStatus } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { ThemeFiles } from '../themes.js'
import type { UpdateService } from '../updates.js'
import type { AgentVersionService } from '../agent-versions.js'
import { SessionManager } from './manager.js'
import type { SessionSleeper } from './sleep.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The orchestrator's preference commands (#1219, second slice): `get_preferences` reads what Settings shows,
 * `set_preferences` changes the reversible settings the window offers through the window's own calls (here the real
 * RPC handler, so the validation is the window's), and "apply updates when idle" turned on waits for the person's card.
 * The update, sleep and agent-version services are stand-ins that record what they were asked.
 */
const COMMANDS = ['get_preferences', 'set_preferences'] as const

let root: string
/** What the host announced, to see that a change reaches every window */
let announced: string[]
let store: Store
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>
let updates: ReturnType<typeof fakeUpdates>
let sleeper: ReturnType<typeof fakeSleeper>
let versions: ReturnType<typeof fakeVersions>

function fakeUpdates() {
  const calls: string[] = []
  let status: UpdateStatus = { current: '1.0.0', latest: '1.1.0', newer: true, auto: true, autoApply: false, phase: 'idle', error: null, checkedAt: null }
  const service = {
    check: async (force: boolean) => {
      calls.push(`check:${force}`)
      return { ...status }
    },
    setAuto: (enabled: boolean) => {
      calls.push(`setAuto:${enabled}`)
      status = { ...status, auto: enabled }
      return { ...status }
    },
    setAutoApply: (enabled: boolean) => {
      calls.push(`setAutoApply:${enabled}`)
      status = { ...status, autoApply: enabled }
      return { ...status }
    },
  }
  return { service: service as unknown as UpdateService, calls, set: (over: Partial<UpdateStatus>) => (status = { ...status, ...over }) }
}

function fakeSleeper() {
  const calls: (number | null)[] = []
  let policy: SleepPolicy = { afterMinutes: 15 }
  const service = {
    policy: () => ({ ...policy }),
    setAfterMinutes: (afterMinutes: number | null) => {
      calls.push(afterMinutes)
      policy = { afterMinutes }
      return { ...policy }
    },
  }
  return { service: service as unknown as SessionSleeper, calls }
}

function fakeVersions() {
  const calls: boolean[] = []
  let status: AgentVersions = { installed: { claude: '2.0.0' }, autoApply: true, checkedAt: null } as AgentVersions
  const service = {
    check: async () => ({ ...status }),
    setAutoApply: (enabled: boolean) => {
      calls.push(enabled)
      status = { ...status, autoApply: enabled }
      return { ...status }
    },
  }
  return { service: service as unknown as AgentVersionService, calls }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-prefs-')))
  store = new Store()
  const adapters = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]])
  const agents = adapters as unknown as Map<ToolName, AgentAdapter>
  announced = []
  mgr = new SessionManager(store, agents, (e) => announced.push(e.type))
  updates = fakeUpdates()
  sleeper = fakeSleeper()
  versions = fakeVersions()
  const themes = new ThemeFiles(join(root, 'themes'), () => {})
  mkdirSync(join(root, 'themes'), { recursive: true })
  const handler = createRpcHandler(mgr, agents, { themes, updates: updates.service, sleeper: sleeper.service, agentVersions: versions.service })
  rpc = (method, params) => handler(method, params)
  mgr.useWindowRpc(rpc)
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The preferences card standing in a session, if one is */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}

function run(orcId: string, command: (typeof COMMANDS)[number], args: Record<string, unknown> = {}) {
  return mgr.runOrchestratorTool(orcId, 'centralu_run', { command, args })
}

/** Runs a command whose card the person answers with `decision`; the card's question and the answer */
async function answered(orcId: string, args: Record<string, unknown>, decision: 'allow' | 'deny' | 'always', whileStanding?: () => Promise<void>) {
  const call = run(orcId, 'set_preferences', args)
  await eventually(() => !!card(orcId))
  const question = card(orcId)!.text
  await whileStanding?.()
  mgr.respondApproval(orcId, card(orcId)!.requestId, decision)
  return { question, r: await call }
}

const prefs = () => rpc('prefs.get', {}) as Promise<Record<string, unknown>>

describe('get_preferences', () => {
  it('reads what Settings shows: the theme and the themes to choose from, the type settings, idle sleep, the update switches', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('- Theme mode: dark; dark theme "Dark" [dark]; light theme "Light" [light]')
    expect(r.text).toContain('"High contrast light" [hc-light] (light)')
    expect(r.text).toContain('- Text size: 1 (0.85, 0.925, 1, 1.1, 1.25; 1 is the default)')
    expect(r.text).toContain("- Body font: the app's own; code font: the app's own")
    expect(r.text).toContain('- Line height: normal (compact, normal, relaxed)')
    expect(r.text).toContain('- Idle sessions sleep after: 15 minutes')
    expect(r.text).toContain('- Automatic updates (check, install, and apply when idle): off (checking is on, installing is off) (autoUpdate, asks the person to turn on)')
    expect(r.text).toContain('running 1.0.0, latest known 1.1.0 (newer)')
    expect(r.text).toContain('- Move idle sessions to a newly installed agent CLI: on')
    // The accent colour is gone from the product (owner decision 2026-10-20): not offered, so not listed
    expect(r.text).not.toMatch(/accent/i)
    // Read only: nothing was set, and nothing was asked of the registry (the stand-in would have said so)
    expect(updates.calls).toEqual(['check:false'])
    expect(sleeper.calls).toEqual([])
  })

  it('says what stays with the person', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('Kept by the person (no command changes these)')
    // Always on (2026-10-20): not a setting, so the inventory does not list it
    expect(r.text).not.toContain('read-only tools')
    expect(r.text).not.toMatch(/sessionTools/)
    expect(r.text).toContain('levels that may start agents 1')
    expect(r.text).not.toContain('the window keeps these switches')
  })

  it('lists a theme file that reads cleanly, quoted, and leaves out a broken one', async () => {
    await rpc('themes.save', { id: null, content: { name: 'Evening "blue"', base: 'dark', tokens: {} } })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('"Evening \\"blue\\"" [evening-blue] (dark, a theme file)')
  })

  it('still answers when a part cannot be read (no update service on this host)', async () => {
    const agents = new Map<ToolName, AgentAdapter>([['claude', new CrossAdapter('claude') as unknown as AgentAdapter]])
    mgr.useWindowRpc(createRpcHandler(mgr, agents, { sleeper: sleeper.service }))
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('- Updates: not available on this host')
    expect(r.text).toContain('- Idle sessions sleep after: 15 minutes')
  })
})

describe('set_preferences: appearance', () => {
  it('picks a theme by id or by name, setting the side of its base and showing that side', async () => {
    const orc = await mgr.orchestrator()
    const byId = await run(orc.id, 'set_preferences', { theme: 'hc-light' })
    expect(byId.isError).toBeFalsy()
    expect(byId.text).toBe('Now: theme "High contrast light" [hc-light] (the light theme, shown now; mode light).')
    expect(await prefs()).toMatchObject({ themeMode: 'light', themeLight: 'hc-light', themeDark: 'dark' })
    const byName = await run(orc.id, 'set_preferences', { theme: 'high CONTRAST dark' })
    expect(byName.text).toContain('[hc-dark] (the dark theme, shown now; mode dark)')
    expect(await prefs()).toMatchObject({ themeMode: 'dark', themeDark: 'hc-dark', themeLight: 'hc-light' })
    expect(card(orc.id)).toBeUndefined()
  })

  it('picks a theme file the person or an agent saved, by its name', async () => {
    await rpc('themes.save', { id: null, content: { name: 'Paper', base: 'light', tokens: {} } })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { theme: 'paper' })
    expect(r.text).toContain('"Paper" [paper] (the light theme')
    expect(await prefs()).toMatchObject({ themeMode: 'light', themeLight: 'paper' })
  })

  it('never stores a mode the window does not offer: only dark or light, whatever the theme', async () => {
    const orc = await mgr.orchestrator()
    await rpc('prefs.set', { patch: { themeMode: 'system' } })
    await run(orc.id, 'set_preferences', { theme: 'light' })
    expect(((await prefs()) as { themeMode: string }).themeMode).toBe('light')
  })

  it('names the themes to choose from when the theme is not one, and changes nothing', async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    const r = await run(orc.id, 'set_preferences', { theme: 'solarized', textSize: 1.25 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('No theme is called "solarized". Choose one of: "Dark" [dark], "Light" [light]')
    // The other change in the same call is not made either: it is refused as a whole before anything is written
    expect(await prefs()).toEqual(before)
  })

  it('refuses a theme name that hides characters, and two themes of one name', async () => {
    await rpc('themes.save', { id: null, content: { name: 'Twin Peaks', base: 'dark', tokens: {} } })
    await rpc('themes.save', { id: null, content: { name: 'Twin Peaks', base: 'light', tokens: {} } })
    const orc = await mgr.orchestrator()
    const hidden = await run(orc.id, 'set_preferences', { theme: 'dark‮' })
    expect(hidden.text).toMatch(/theme has a control or formatting character/)
    const twice = await run(orc.id, 'set_preferences', { theme: 'twin peaks' })
    expect(twice.text).toMatch(/Several themes are called "twin peaks"; give one of their ids: twin-peaks, twin-peaks-2/)
  })

  it('sets the text size to the nearest step, as the window does', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { textSize: 1.2 })
    expect(r.text).toBe('Now: text size 1.25.')
    expect(((await prefs()) as { textSize: number }).textSize).toBe(1.25)
  })

  it('sets and clears the fonts and the line height', async () => {
    const orc = await mgr.orchestrator()
    const set = await run(orc.id, 'set_preferences', { bodyFont: ' Inter ', codeFont: 'JetBrains Mono', lineHeight: 'relaxed' })
    expect(set.text).toBe('Now: body font "Inter"; code font "JetBrains Mono"; line height relaxed.')
    expect(await prefs()).toMatchObject({ bodyFont: 'Inter', codeFont: 'JetBrains Mono', lineHeight: 'relaxed' })
    const cleared = await run(orc.id, 'set_preferences', { bodyFont: '', codeFont: '' })
    expect(cleared.text).toBe("Now: body font the app's own; code font the app's own.")
    expect(await prefs()).toMatchObject({ bodyFont: '', codeFont: '', lineHeight: 'relaxed' })
  })

  it("refuses a font the window's own schema refuses (too long), and one with a hidden character, changing nothing", async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    const long = await run(orc.id, 'set_preferences', { bodyFont: 'x'.repeat(201) })
    expect(long.isError).toBe(true)
    expect(long.text).toMatch(/Nothing changed: .*bodyFont/)
    // The window's call says the same
    await expect(rpc('prefs.set', { patch: { bodyFont: 'x'.repeat(201) } })).rejects.toThrow(/bodyFont/)
    const hidden = await run(orc.id, 'set_preferences', { codeFont: 'Menlo\u0007' })
    expect(hidden.text).toMatch(/codeFont has a control or formatting character/)
    expect(await prefs()).toEqual(before)
  })
})

describe('the notification switches (#1306)', () => {
  it('are read with the other settings, without the "error" and "every session finished" ones the product dropped', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('Notifications (set_preferences notifications)')
    expect(r.text).toContain(
      '- Approval needed: on; a session finishes out of sight: on; even while the app is focused: off; sound: on; turning the approval one off, or the sound while it notifies, asks the person',
    )
    expect(r.text).not.toMatch(/error: |every session finished/)
  })

  it("start from the window's workspace snapshot, which the host reads once", async () => {
    await rpc('workspace.save', { layout: { notifyPolicy: { approval: false, error: true, done: true, allDone: true, whenFocused: false, sound: false } } })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('- Approval needed: off; a session finishes out of sight: on; even while the app is focused: off; sound: off')
    // The snapshot is read once: a window of an older build writing it again changes nothing
    await rpc('workspace.save', { layout: { notifyPolicy: { approval: true, error: true, done: true, allDone: true, whenFocused: true, sound: true } } })
    expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(false)
  })

  it('change one switch at once with no card, the others staying, and every window is told', async () => {
    const orc = await mgr.orchestrator()
    announced.length = 0
    const r = await run(orc.id, 'set_preferences', { notifications: { done: false, whenFocused: true } })
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe('Now: notifications: approval on, a session finishes out of sight off, even while focused on, sound on.')
    // The stored record keeps the dropped switches as they were, for older builds
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: false, allDone: true, whenFocused: true, sound: true })
    expect(announced.filter((t) => t === 'prefs_changed')).toEqual(['prefs_changed'])
    expect(card(orc.id)).toBeUndefined()
    // A second call changes only its own switch
    await run(orc.id, 'set_preferences', { notifications: { whenFocused: false } })
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: false, allDone: true, whenFocused: false, sound: true })
  })

  // Owner decision 2026-10-20: the window no longer raises the "error" and "every session finished" notifications
  it('refuse the "error" and "every session finished" switches by name, changing nothing', async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    for (const args of [{ notifications: { error: false } }, { notifications: { allDone: false } }, { notifications: { error: true, done: false } }]) {
      const r = await run(orc.id, 'set_preferences', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toMatch(/Unrecognized key/)
    }
    expect(card(orc.id)).toBeUndefined()
    expect(await prefs()).toEqual(before)
  })

  // Turning off what says a card waits is the orchestrator choosing what the person stops hearing about
  describe('the approval notification', () => {
    it('asks before it is turned off, naming what stops notifying, and turns it off on Allow', async () => {
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { notifications: { approval: false } }, 'allow')
      expect(question).toContain('Stop the "awaiting approval" notification?')
      expect(question).toContain('no longer show a notice or play a sound when an agent waits for your approval')
      expect(question).toContain('an approval could go unnoticed while you are away')
      expect(question).not.toMatch(/error|a session fails/)
      expect(r.isError).toBeFalsy()
      expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(false)
    })

    it('keeps notifying when the person denies, the other switches of the call still changing', async () => {
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, { notifications: { approval: false, done: false } }, 'deny')
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('a session finishes out of sight off')
      expect(r.text).toContain('Not changed: Notifications: The person did not approve it, so it keeps notifying.')
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: true, done: false })
    })

    it('asks under auto too, and "always" remembers nothing', async () => {
      const orc = await mgr.orchestrator()
      await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
      await answered(orc.id, { notifications: { approval: false } }, 'always')
      await run(orc.id, 'set_preferences', { notifications: { approval: true } })
      const again = await answered(orc.id, { notifications: { approval: false } }, 'deny')
      expect(again.r.isError).toBe(true)
      expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(true)
    })

    it('asks nothing for one already off, and writes nothing the card did not name', async () => {
      const orc = await mgr.orchestrator()
      await rpc('prefs.set', { patch: { notifyPolicy: { approval: false } } })
      const off = await run(orc.id, 'set_preferences', { notifications: { approval: false, done: false } })
      expect(off.isError).toBeFalsy()
      expect(card(orc.id)).toBeUndefined()
      // The person changes another switch while the card stands: only what the card named is written over it
      await rpc('prefs.set', { patch: { notifyPolicy: { approval: true } } })
      await answered(orc.id, { notifications: { approval: false } }, 'allow', async () => {
        await rpc('prefs.set', { patch: { notifyPolicy: { done: true } } })
      })
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: false, done: true })
    })

    it('asks when the switches cannot be read, as if it were on', async () => {
      const orc = await mgr.orchestrator()
      mgr.useWindowRpc((method, params) => (method === 'prefs.get' ? Promise.reject(new Error('unreadable')) : rpc(method, params)))
      await rpc('prefs.set', { patch: { notifyPolicy: { approval: false } } })
      const { question } = await answered(orc.id, { notifications: { approval: false } }, 'deny')
      expect(question).toContain('Stop the "awaiting approval" notification?')
    })

    it('asks nothing for turning it on, or for any other switch', async () => {
      const orc = await mgr.orchestrator()
      await rpc('prefs.set', { patch: { notifyPolicy: { approval: false } } })
      const on = await run(orc.id, 'set_preferences', { notifications: { approval: true, done: false, whenFocused: true } })
      expect(on.isError).toBeFalsy()
      expect(card(orc.id)).toBeUndefined()
    })
  })

  // The sound is how an approval reaches someone away: muting it while an approval would still notify is the same stop
  describe('the sound', () => {
    it('asks to be turned off while an approval would still notify, saying that it is how an approval reaches the person', async () => {
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { notifications: { sound: false } }, 'allow')
      expect(question).toContain('Turn off the notification sound?')
      expect(question).toContain('The sound is how an approval reaches you when you are away')
      expect(question).not.toContain('error')
      expect(r.isError).toBeFalsy()
      expect(((await prefs()) as { notifyPolicy: { sound: boolean } }).notifyPolicy.sound).toBe(false)
    })

    it('stays on when the person denies, and the other switches of the call still change', async () => {
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, { notifications: { sound: false, done: false } }, 'deny')
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('Not changed: Notifications: The person did not approve it, so the sound stays on.')
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ sound: true, done: false })
    })

    it('asks under auto too, and "always" remembers nothing', async () => {
      const orc = await mgr.orchestrator()
      await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
      await answered(orc.id, { notifications: { sound: false } }, 'always')
      await run(orc.id, 'set_preferences', { notifications: { sound: true } })
      const again = await answered(orc.id, { notifications: { sound: false } }, 'deny')
      expect(again.r.isError).toBe(true)
    })

    it('is one card with the approval notification, and a denial keeps both on', async () => {
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { notifications: { approval: false, sound: false } }, 'deny')
      expect(question).toContain('Stop the "awaiting approval" notification?')
      expect(question).toContain('The sound is also turned off')
      expect(r.isError).toBe(true)
      expect(r.text).toContain('the approval notification and the sound stay on')
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: true, sound: true })
    })

    it('goes off with the approval notification on one Allow, and with no card once it no longer notifies, whatever "error" holds', async () => {
      const orc = await mgr.orchestrator()
      const both = await answered(orc.id, { notifications: { approval: false, sound: false } }, 'allow')
      expect(both.question).not.toContain('Turn off the notification sound?')
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: false, sound: false })
      // Nothing left to silence: "error" is still on in the record, but the window no longer raises it
      expect(((await prefs()) as { notifyPolicy: { error: boolean } }).notifyPolicy.error).toBe(true)
      await run(orc.id, 'set_preferences', { notifications: { sound: true } })
      const quiet = await run(orc.id, 'set_preferences', { notifications: { sound: false } })
      expect(quiet.isError).toBeFalsy()
      expect(card(orc.id)).toBeUndefined()
    })

    it('asks when the switches cannot be read, and nothing for turning it on or for one already off', async () => {
      const orc = await mgr.orchestrator()
      await rpc('prefs.set', { patch: { notifyPolicy: { sound: false } } })
      const already = await run(orc.id, 'set_preferences', { notifications: { sound: false, whenFocused: true } })
      expect(already.isError).toBeFalsy()
      const on = await run(orc.id, 'set_preferences', { notifications: { sound: true } })
      expect(on.isError).toBeFalsy()
      expect(card(orc.id)).toBeUndefined()
      mgr.useWindowRpc((method, params) => (method === 'prefs.get' ? Promise.reject(new Error('unreadable')) : rpc(method, params)))
      const { question } = await answered(orc.id, { notifications: { sound: false } }, 'deny')
      expect(question).toContain('Turn off the notification sound?')
    })
  })

  it('merge into what the window saved meanwhile: a patch carrying one switch does not undo another', async () => {
    const orc = await mgr.orchestrator()
    await rpc('prefs.set', { patch: { notifyPolicy: { whenFocused: true } } })
    await run(orc.id, 'set_preferences', { notifications: { done: false } })
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: false, allDone: true, whenFocused: true, sound: true })
  })

  it('refuse a switch that does not exist, one that is not a boolean, and an empty list, changing nothing', async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    for (const args of [{ notifications: { volume: true } }, { notifications: { sound: 'loud' } }, { notifications: { sound: 1 } }]) {
      const r = await run(orc.id, 'set_preferences', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
    }
    const empty = await run(orc.id, 'set_preferences', { notifications: {} })
    expect(empty.isError).toBe(true)
    expect(empty.text).toMatch(/Nothing to change/)
    expect(await prefs()).toEqual(before)
  })

  it('go with the other changes of one call, and a switch the window would refuse is refused as the window refuses it', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { textSize: 1.1, notifications: { done: false } })
    expect(r.text).toContain('Now: text size 1.1.')
    expect(r.text).toContain('a session finishes out of sight off')
    // The window's own call, with a value that is no boolean, is refused by the same schema
    await expect(rpc('prefs.set', { patch: { notifyPolicy: { sound: 'loud' } } })).rejects.toThrow(/sound/)
  })
})

describe('set_preferences: idle sleep and the update switches', () => {
  it('sets when idle sessions sleep, or never', async () => {
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'set_preferences', { idleSleepMinutes: 30 })).text).toBe('Idle sessions sleep after 30 minutes.')
    expect((await run(orc.id, 'set_preferences', { idleSleepMinutes: 'never' })).text).toBe('Idle sessions sleep after never.')
    expect(sleeper.calls).toEqual([30, null])
  })

  it('refuses a sleep time that is no whole number of minutes, before any call', async () => {
    const orc = await mgr.orchestrator()
    for (const value of [0, -5, 1.5, 'soon']) {
      const r = await run(orc.id, 'set_preferences', { idleSleepMinutes: value })
      expect(r.isError, String(value)).toBe(true)
    }
    expect(sleeper.calls).toEqual([])
  })

  it('moves idle sessions to a new agent CLI on and off at once, with no card', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { moveIdleSessionsToNewAgentCli: false })
    expect(r.text).toContain('Moving idle sessions to a newly installed agent CLI is off.')
    expect(versions.calls).toEqual([false])
    expect(card(orc.id)).toBeUndefined()
  })

  /*
   * Owner decision 2026-10-20: one "Automatic updates" setting, checking plus installing and applying when idle. Turning it
   * on is still the card #1309 added: with both on, code arrives without a later question
   */
  describe('autoUpdate', () => {
    it('asks before turning it on, saying that code then arrives unasked, and turns both halves on only on Allow', async () => {
      updates.set({ auto: false, autoApply: false })
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { autoUpdate: true }, 'allow')
      expect(question).toContain('Turn on "Automatic updates"?')
      expect(question).toContain('installs it by itself')
      expect(question).toContain('without asking again')
      expect(r.text).toBe('Automatic updates are on.')
      expect(updates.calls).toEqual(['check:false', 'setAuto:true', 'setAutoApply:true'])
    })

    it('asks when only one half is off, and ends with both on', async () => {
      // Checking on, installing off: what every host had before 2026-10-20 unless the person turned apply on
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { autoUpdate: true }, 'allow')
      expect(question).toContain('Turn on "Automatic updates"?')
      expect(r.text).toBe('Automatic updates are on.')
      expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual(['setAuto:true', 'setAutoApply:true'])
    })

    it('asks when the switches cannot be read, as if off', async () => {
      updates.set({ auto: true, autoApply: true })
      const orc = await mgr.orchestrator()
      mgr.useWindowRpc((method, params) => (method === 'updates.status' ? Promise.reject(new Error('unreadable')) : rpc(method, params)))
      const { question } = await answered(orc.id, { autoUpdate: true }, 'deny')
      expect(question).toContain('Turn on "Automatic updates"?')
    })

    it('turns off without reading the switches first, and says which half is on when it stops halfway', async () => {
      updates.set({ auto: true, autoApply: true })
      const orc = await mgr.orchestrator()
      mgr.useWindowRpc((method, params) =>
        method === 'updates.setAuto' ? Promise.reject(new Error('the store is busy')) : rpc(method, params),
      )
      const r = await run(orc.id, 'set_preferences', { autoUpdate: false })
      expect(r.isError).toBeFalsy()
      expect(r.text).toBe('Automatic updates are now off (checking is on, installing is off).\nNot changed: Automatic updates: the store is busy')
      expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual(['setAutoApply:false'])
    })

    it('leaves both halves as they were when the person denies, and still makes the other changes of the call', async () => {
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, { autoUpdate: true, textSize: 1.1 }, 'deny')
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('Now: text size 1.1.')
      expect(r.text).toContain('Not changed: Automatic updates: The person did not approve it, so it stays off.')
      expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual([])
    })

    it('answers nothing changed when the one change asked for is denied', async () => {
      const orc = await mgr.orchestrator()
      const { r } = await answered(orc.id, { autoUpdate: true }, 'deny')
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/Nothing changed\. Automatic updates: The person did not approve it/)
    })

    it('asks under auto too, and "always" is read as allow, once: the next turn-on asks again', async () => {
      const orc = await mgr.orchestrator()
      await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
      await answered(orc.id, { autoUpdate: true }, 'always')
      expect(updates.calls).toContain('setAutoApply:true')
      await run(orc.id, 'set_preferences', { autoUpdate: false })
      const again = await answered(orc.id, { autoUpdate: true }, 'deny')
      expect(again.r.isError).toBe(true)
      expect(updates.calls.filter((c) => c === 'setAutoApply:true').length).toBe(1)
    })

    it('turns off with no card, installing first, and asks nothing when it is already on', async () => {
      updates.set({ auto: true, autoApply: true })
      const orc = await mgr.orchestrator()
      const already = await run(orc.id, 'set_preferences', { autoUpdate: true })
      expect(already.text).toBe('Automatic updates are on.')
      expect(card(orc.id)).toBeUndefined()
      const off = await run(orc.id, 'set_preferences', { autoUpdate: false })
      expect(off.text).toBe('Automatic updates are off.')
      expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual(['setAutoApply:false', 'setAuto:false'])
      expect(card(orc.id)).toBeUndefined()
    })

    it('is read as one setting, saying which half is on when they differ', async () => {
      const orc = await mgr.orchestrator()
      expect((await run(orc.id, 'get_preferences')).text).toContain('- Automatic updates (check, install, and apply when idle): off (checking is on, installing is off) (autoUpdate')
      updates.set({ auto: true, autoApply: true })
      expect((await run(orc.id, 'get_preferences')).text).toContain('- Automatic updates (check, install, and apply when idle): on (autoUpdate, asks the person to turn on)')
    })

    it('refuses the separate switches it replaced, by name', async () => {
      const orc = await mgr.orchestrator()
      for (const args of [{ checkForUpdates: true }, { applyUpdatesWhenIdle: true }, { checkForUpdates: false }]) {
        const r = await run(orc.id, 'set_preferences', args)
        expect(r.isError, JSON.stringify(args)).toBe(true)
        expect(r.text, JSON.stringify(args)).toMatch(/Unrecognized key/)
      }
      expect(card(orc.id)).toBeUndefined()
      expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual([])
    })
  })

  it('reports a part that could not be changed and still makes the rest (no update service on this host)', async () => {
    const agents = new Map<ToolName, AgentAdapter>([['claude', new CrossAdapter('claude') as unknown as AgentAdapter]])
    mgr.useWindowRpc(createRpcHandler(mgr, agents, { sleeper: sleeper.service }))
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { idleSleepMinutes: 5, autoUpdate: false })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Idle sessions sleep after 5 minutes.')
    expect(r.text).toContain('Not changed: Automatic updates: Update checks are unavailable')
  })
})

describe('what set_preferences does not reach', () => {
  it('has no field for what stays with the person: an unknown or trust-changing setting is refused by name', async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    for (const args of [{ sessionTools: false }, { agentCeiling: 0 }, { agentDepth: 3 }, { agentModels: {} }, { sendWithModifierEnter: true }, { themeMode: 'system' }, { fontSize: 14 }, { accent: '#ff0000' }]) {
      const r = await run(orc.id, 'set_preferences', args)
      expect(r.isError, JSON.stringify(args)).toBe(true)
      expect(r.text, JSON.stringify(args)).toMatch(/Unrecognized key/)
    }
    expect(await prefs()).toEqual(before)
  })

  it('says what it can change when there is nothing to change', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', {})
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Nothing to change: give at least one of theme, textSize/)
  })
})

describe('who may run them', () => {
  it('are found through centralu_commands, as the instructions say: "machine" lists the machine commands, and the settings and trash ones are named', async () => {
    const orc = await mgr.orchestrator()
    const machines = (await mgr.runOrchestratorTool(orc.id, 'centralu_commands', { query: 'machine' })).text
    for (const name of ['add_machine', 'install_machine', 'remove_machine', 'reconnect_machine', 'set_machine_auto_reconnect', 'set_machine_autostart']) expect(machines, name).toContain(`- ${name}:`)
    const trash = (await mgr.runOrchestratorTool(orc.id, 'centralu_commands', { query: 'trash' })).text
    for (const name of ['list_trash', 'restore_trashed', 'trash_subagent_steps', 'delete_trashed', 'empty_trash']) expect(trash, name).toContain(`- ${name}:`)
    const prefs = (await mgr.runOrchestratorTool(orc.id, 'centralu_commands', { query: 'preferences' })).text
    expect(prefs).toContain('- get_preferences:')
    expect(prefs).toContain('- set_preferences:')
  })

  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    for (const name of COMMANDS) {
      expect(commandsFor('orchestrator', 'commands')).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
        }
      }
    }
  })

  it("refuses an ordinary session's calls by name and through centralu_run, and changes nothing", async () => {
    const dir = join(root, 'proj')
    mkdirSync(dir)
    const project = (await rpc('projects.add', { path: dir })) as { id: string }
    await rpc('projects.setTrusted', { projectId: project.id, trusted: true })
    const s = (await rpc('agents.createSession', { projectId: project.id, cwd: dir, tool: 'claude' })) as { id: string }
    const before = await prefs()
    for (const name of COMMANDS) {
      await expect(mgr.runOrchestratorTool(s.id, name, { textSize: 1.25 }), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(s.id, 'centralu_run', { command: name, args: { textSize: 1.25 } }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect(await prefs()).toEqual(before)
    expect(updates.calls).toEqual([])
  })
})
