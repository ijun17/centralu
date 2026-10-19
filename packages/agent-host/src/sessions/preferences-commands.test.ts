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
    expect(r.text).toContain('- Check for updates automatically: on (checkForUpdates); apply updates automatically when idle: off')
    expect(r.text).toContain('running 1.0.0, latest known 1.1.0 (newer)')
    expect(r.text).toContain('- Move idle sessions to a newly installed agent CLI: on')
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
  it('are read with the other settings', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('Notifications (set_preferences notifications)')
    expect(r.text).toContain('- Approval needed: on; error: on; a session finishes out of sight: on; every session finished: on; even while the app is focused: off; sound: on')
  })

  it("start from the window's workspace snapshot, which the host reads once", async () => {
    await rpc('workspace.save', { layout: { notifyPolicy: { approval: false, error: true, done: true, allDone: true, whenFocused: false, sound: false } } })
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'get_preferences')
    expect(r.text).toContain('- Approval needed: off; error: on; a session finishes out of sight: on; every session finished: on; even while the app is focused: off; sound: off')
    // The snapshot is read once: a window of an older build writing it again changes nothing
    await rpc('workspace.save', { layout: { notifyPolicy: { approval: true, error: true, done: true, allDone: true, whenFocused: true, sound: true } } })
    expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(false)
  })

  it('change one switch at once with no card, the others staying, and every window is told', async () => {
    const orc = await mgr.orchestrator()
    announced.length = 0
    const r = await run(orc.id, 'set_preferences', { notifications: { allDone: false, whenFocused: true } })
    expect(r.isError).toBeFalsy()
    expect(r.text).toBe('Now: notifications: approval on, error on, a session finishes out of sight on, every session finished off, even while focused on, sound on.')
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: true, allDone: false, whenFocused: true, sound: true })
    expect(announced.filter((t) => t === 'prefs_changed')).toEqual(['prefs_changed'])
    expect(card(orc.id)).toBeUndefined()
    // A second call changes only its own switch
    await run(orc.id, 'set_preferences', { notifications: { done: false } })
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: false, allDone: false, whenFocused: true, sound: true })
  })

  // Turning off the two that tell the person a card waits is the orchestrator choosing what they stop hearing about
  describe('the ones that say a card waits', () => {
    it('ask before they are turned off, naming what stops notifying, and turn them off on Allow', async () => {
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { notifications: { approval: false } }, 'allow')
      expect(question).toContain('Stop the "awaiting approval" notification?')
      expect(question).toContain('no longer show a notice or play a sound when an agent waits for your approval')
      expect(question).toContain('an approval could go unnoticed while you are away')
      expect(r.isError).toBeFalsy()
      expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(false)
      // Both at once are one card
      const both = await answered(orc.id, { notifications: { error: false, approval: false } }, 'allow')
      expect(both.question).toContain('Stop the "error" notification?')
      expect(both.question).not.toContain('awaiting approval')
    })

    it('ask once for both, and keep them notifying when the person denies, the other switches of the call still changing', async () => {
      const orc = await mgr.orchestrator()
      const { question, r } = await answered(orc.id, { notifications: { approval: false, error: false, done: false } }, 'deny')
      expect(question).toContain('Stop the "awaiting approval" and "error" notifications?')
      expect(question).toContain('an agent waits for your approval or a session fails')
      expect(question).toContain('an approval or a failure could go unnoticed')
      expect(r.isError).toBeFalsy()
      expect(r.text).toContain('a session finishes out of sight off')
      expect(r.text).toContain('Not changed: Notifications: The person did not approve it, so they keep notifying.')
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: true, done: false, allDone: true, whenFocused: false, sound: true })
    })

    it('ask under auto too, and "always" remembers nothing', async () => {
      const orc = await mgr.orchestrator()
      await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
      await answered(orc.id, { notifications: { approval: false } }, 'always')
      await run(orc.id, 'set_preferences', { notifications: { approval: true } })
      const again = await answered(orc.id, { notifications: { approval: false } }, 'deny')
      expect(again.r.isError).toBe(true)
      expect(((await prefs()) as { notifyPolicy: { approval: boolean } }).notifyPolicy.approval).toBe(true)
    })

    it('write nothing the card did not name: one already off is left out, also when the person turns it on while the card stands', async () => {
      const orc = await mgr.orchestrator()
      await rpc('prefs.set', { patch: { notifyPolicy: { approval: false } } })
      const { question } = await answered(orc.id, { notifications: { approval: false, error: false } }, 'allow', async () => {
        await rpc('prefs.set', { patch: { notifyPolicy: { approval: true } } })
      })
      expect(question).toContain('Stop the "error" notification?')
      expect(question).not.toContain('awaiting approval')
      // error went off as the card said; approval, which the card did not name, is as the person left it
      expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: true, error: false })
    })

    it('ask when the switches cannot be read, as if they were on', async () => {
      const orc = await mgr.orchestrator()
      mgr.useWindowRpc((method, params) => (method === 'prefs.get' ? Promise.reject(new Error('unreadable')) : rpc(method, params)))
      await rpc('prefs.set', { patch: { notifyPolicy: { error: false } } })
      const { question } = await answered(orc.id, { notifications: { error: false } }, 'deny')
      expect(question).toContain('Stop the "error" notification?')
    })

    // The sound is how an approval or an error reaches someone away: muting it while either would still notify is the same stop
    describe('the sound', () => {
      it('asks to be turned off while an approval or an error would still notify, saying that it is how they reach the person', async () => {
        const orc = await mgr.orchestrator()
        const { question, r } = await answered(orc.id, { notifications: { sound: false } }, 'allow')
        expect(question).toContain('Turn off the notification sound?')
        expect(question).toContain('how an approval or an error reaches you when you are away')
        expect(r.isError).toBeFalsy()
        expect(((await prefs()) as { notifyPolicy: { sound: boolean } }).notifyPolicy.sound).toBe(false)
      })

      it('stays on when the person denies, and the other switches of the call still change', async () => {
        const orc = await mgr.orchestrator()
        const { r } = await answered(orc.id, { notifications: { sound: false, allDone: false } }, 'deny')
        expect(r.isError).toBeFalsy()
        expect(r.text).toContain('Not changed: Notifications: The person did not approve it, so the sound stays on.')
        expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ sound: true, allDone: false })
      })

      it('asks under auto too, and "always" remembers nothing', async () => {
        const orc = await mgr.orchestrator()
        await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
        await answered(orc.id, { notifications: { sound: false } }, 'always')
        await run(orc.id, 'set_preferences', { notifications: { sound: true } })
        const again = await answered(orc.id, { notifications: { sound: false } }, 'deny')
        expect(again.r.isError).toBe(true)
      })

      it('is one card with the approval and error notifications, and a denial keeps the sound too, since off it would silence them', async () => {
        const orc = await mgr.orchestrator()
        // Approval is turned off with the sound, error stays on: the sound would still be what error reaches the person with
        const { question, r } = await answered(orc.id, { notifications: { approval: false, sound: false } }, 'deny')
        expect(question).toContain('Stop the "awaiting approval" notification?')
        expect(question).toContain('The sound is also turned off')
        expect(r.isError).toBe(true)
        expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: true, sound: true })
        // Both notifications and the sound off together: denied, the sound stays on with them
        const all = await answered(orc.id, { notifications: { approval: false, error: false, sound: false } }, 'deny')
        expect(all.r.isError).toBe(true)
        expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: true, error: true, sound: true })
      })

      it('goes off with the approval and error notifications on one Allow, and with no card once neither notifies', async () => {
        const orc = await mgr.orchestrator()
        const both = await answered(orc.id, { notifications: { approval: false, error: false, sound: false } }, 'allow')
        expect(both.question).not.toContain('Turn off the notification sound?')
        expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toMatchObject({ approval: false, error: false, sound: false })
        // Nothing left to silence: turning the sound on and off again asks nothing
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

    it('ask nothing for turning them on, for one already off, or for any other switch', async () => {
      const orc = await mgr.orchestrator()
      await rpc('prefs.set', { patch: { notifyPolicy: { error: false } } })
      const off = await run(orc.id, 'set_preferences', { notifications: { error: false, approval: true, done: false, allDone: false, whenFocused: true } })
      expect(off.isError).toBeFalsy()
      const on = await run(orc.id, 'set_preferences', { notifications: { error: true } })
      expect(on.isError).toBeFalsy()
      expect(card(orc.id)).toBeUndefined()
      // ...while turning one off from on is what asks
      const stop = await answered(orc.id, { notifications: { error: false } }, 'deny')
      expect(stop.question).toContain('Stop the "error" notification?')
    })
  })

  it('merge into what the window saved meanwhile: a patch carrying one switch does not undo another', async () => {
    const orc = await mgr.orchestrator()
    await rpc('prefs.set', { patch: { notifyPolicy: { error: false } } })
    await run(orc.id, 'set_preferences', { notifications: { done: false } })
    expect(((await prefs()) as { notifyPolicy: unknown }).notifyPolicy).toEqual({ approval: true, error: false, done: false, allDone: true, whenFocused: false, sound: true })
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
    const r = await run(orc.id, 'set_preferences', { textSize: 1.1, notifications: { allDone: false } })
    expect(r.text).toContain('Now: text size 1.1.')
    expect(r.text).toContain('every session finished off')
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

  it('turns update checking and moving idle sessions to a new agent CLI on and off at once, with no card', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { checkForUpdates: false, moveIdleSessionsToNewAgentCli: false })
    expect(r.text).toContain('Checking for updates automatically is off.')
    expect(r.text).toContain('Moving idle sessions to a newly installed agent CLI is off.')
    expect(updates.calls).toEqual(['setAuto:false'])
    expect(versions.calls).toEqual([false])
    expect(card(orc.id)).toBeUndefined()
  })

  it('asks before turning on "apply updates when idle", saying that code then arrives unasked, and turns it on only on Allow', async () => {
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, { applyUpdatesWhenIdle: true }, 'allow')
    expect(question).toContain('Turn on "Apply updates automatically when idle"?')
    expect(question).toContain('installs a newer Centralu by itself')
    expect(question).toContain('without asking again')
    expect(r.text).toBe('Applying updates automatically when idle is on.')
    expect(updates.calls).toEqual(['check:false', 'setAutoApply:true'])
  })

  it('leaves it off when the person denies, but still makes the other changes of the same call', async () => {
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, { applyUpdatesWhenIdle: true, textSize: 1.1 }, 'deny')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Now: text size 1.1.')
    expect(r.text).toContain('Not changed: Applying updates: The person did not approve it, so it stays off.')
    expect(updates.calls.filter((c) => c.startsWith('setAutoApply'))).toEqual([])
    expect(((await prefs()) as { textSize: number }).textSize).toBe(1.1)
  })

  it('answers nothing changed when the one change asked for is denied', async () => {
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, { applyUpdatesWhenIdle: true }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Nothing changed\. Applying updates: The person did not approve it/)
  })

  it('asks under auto too, and "always" is read as allow, once: the next turn-on asks again', async () => {
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
    await answered(orc.id, { applyUpdatesWhenIdle: true }, 'always')
    expect(updates.calls).toContain('setAutoApply:true')
    await run(orc.id, 'set_preferences', { applyUpdatesWhenIdle: false })
    const again = await answered(orc.id, { applyUpdatesWhenIdle: true }, 'deny')
    expect(again.r.isError).toBe(true)
    expect(updates.calls.filter((c) => c === 'setAutoApply:true').length).toBe(1)
  })

  it('asks before turning checking on while apply is on, since that is the other half: a check installs at once', async () => {
    updates.set({ auto: false, autoApply: true })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, { checkForUpdates: true }, 'allow')
    expect(question).toContain('Turn on checking for updates automatically? "Apply updates automatically when idle" is on')
    expect(question).toContain('installs it by itself')
    expect(r.text).toBe('Checking for updates automatically is on.')
    expect(updates.calls).toEqual(['check:false', 'setAuto:true'])
  })

  it('leaves checking off when that card is denied, and turning checking on while apply is off asks nothing', async () => {
    updates.set({ auto: false, autoApply: true })
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, { checkForUpdates: true }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Update checks: The person did not approve it, so it stays off/)
    expect(updates.calls.filter((c) => c.startsWith('setAuto'))).toEqual([])
    // With apply off there is nothing for a check to install unasked
    updates.set({ auto: false, autoApply: false })
    const free = await run(orc.id, 'set_preferences', { checkForUpdates: true })
    expect(free.text).toBe('Checking for updates automatically is on.')
    expect(card(orc.id)).toBeUndefined()
  })

  it('asks once for both switches turned on together, and a denial leaves checking on alone as the person had it', async () => {
    updates.set({ auto: false, autoApply: false })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, { checkForUpdates: true, applyUpdatesWhenIdle: true }, 'deny')
    expect(question).toContain('Turn on "Apply updates automatically when idle"?')
    // Apply stays off, so checking by itself installs nothing and goes ahead
    expect(r.text).toContain('Checking for updates automatically is on.')
    expect(r.text).toContain('Not changed: Applying updates: The person did not approve it')
    expect(updates.calls.filter((c) => c.startsWith('set'))).toEqual(['setAuto:true'])
  })

  it('turning it off, or on when it already is, asks nothing', async () => {
    const orc = await mgr.orchestrator()
    const off = await run(orc.id, 'set_preferences', { applyUpdatesWhenIdle: false })
    expect(off.text).toBe('Applying updates automatically when idle is off.')
    updates.set({ autoApply: true })
    const already = await run(orc.id, 'set_preferences', { applyUpdatesWhenIdle: true })
    expect(already.text).toBe('Applying updates automatically when idle is on.')
    expect(card(orc.id)).toBeUndefined()
  })

  it('reports a part that could not be changed and still makes the rest (no update service on this host)', async () => {
    const agents = new Map<ToolName, AgentAdapter>([['claude', new CrossAdapter('claude') as unknown as AgentAdapter]])
    mgr.useWindowRpc(createRpcHandler(mgr, agents, { sleeper: sleeper.service }))
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'set_preferences', { idleSleepMinutes: 5, checkForUpdates: false })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Idle sessions sleep after 5 minutes.')
    expect(r.text).toContain('Not changed: Update checks: Update checks are unavailable')
  })
})

describe('what set_preferences does not reach', () => {
  it('has no field for what stays with the person: an unknown or trust-changing setting is refused by name', async () => {
    const orc = await mgr.orchestrator()
    const before = await prefs()
    for (const args of [{ sessionTools: false }, { agentCeiling: 0 }, { agentDepth: 3 }, { agentModels: {} }, { sendWithModifierEnter: true }, { themeMode: 'system' }, { fontSize: 14 }]) {
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
    for (const name of ['add_machine', 'install_machine', 'remove_machine', 'reconnect_machine', 'set_machine_connect', 'set_machine_autostart']) expect(machines, name).toContain(`- ${name}:`)
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
