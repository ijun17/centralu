import { describe, expect, it } from 'vitest'
import { errorMessage } from '@cc/protocol'
import { SessionRefs, type RefComputers, type HereSession } from './session-refs.js'
import type { FoundEntry } from './find.js'

/** How a tool's session argument is read on a hub (`hub-0000000a`, machine `m1`) or a machine (linked by hubs) */
const HOST = 'hub-0000000a'
const here = (id: string, name: string): HereSession => ({ id, name, project: null, state: 'idle' })
const entry = (address: string, name: string): FoundEntry => ({ address, name, project: null, machine: 'Remote box', role: 'session', state: 'idle', busy: false, at: 1 })

function refs(o: { sessions?: HereSession[]; machines?: string[]; hubs?: { id: string; label: string; name: string; you?: string }[]; mirror?: FoundEntry[]; assistant?: string | null } = {}) {
  const computers: RefComputers = {
    machine: (id) => (o.machines ?? []).includes(id),
    hubs: () => (o.hubs ?? []).map((h) => ({ you: null, ...h })),
    mirrored: (name) => (o.mirror ?? []).filter((e) => e.name === name),
  }
  return new SessionRefs({ hostId: HOST, sessions: () => o.sessions ?? [here('a', 'alpha'), here('b', 'beta')], assistantId: () => o.assistant ?? null, computers: () => computers })
}

const refusal = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return errorMessage(e)
  }
  return 'not refused'
}

describe('what a tool reads a session argument as', () => {
  it("a role word, an app's address as it is, and a session here by its id or its name", () => {
    const r = refs()
    expect(['Assistant', 'parent', 'person'].map((t) => r.ref('a', t))).toEqual([{ role: 'assistant' }, { role: 'parent' }, { role: 'person' }])
    expect(r.ref('a', `app:${HOST}/p1/x`)).toEqual({ address: `app:${HOST}/p1/x` })
    expect(r.ref('a', 'b')).toEqual({ word: 'b', here: [here('b', 'beta')] })
    expect(r.ref('a', ' Beta ')).toEqual({ word: 'Beta', here: [here('b', 'beta')] })
    // Its own name is not the caller's to write to: an heir has the name of the session it replaced
    expect(r.ref('a', 'alpha')).toEqual({ word: 'alpha', here: [] })
  })

  it('refuses a text shaped as an address that is not one, saying the id to write when it names a session here, and never reads it as a name', () => {
    const r = refs()
    expect(refusal(() => r.ref('a', 'session:b'))).toBe('"session:b" is not a session\'s address. For that session, write "b". Name a session by its id (<id> here, <computer>.<id> on another computer), its name, or "assistant", "parent" or "person".')
    expect(refusal(() => r.ref('a', 'Session:nobody'))).toMatch(/^"Session:nobody" is not a session's address\. Name a session by/)
    expect(refusal(() => r.ref('a', 'session:/b'))).toMatch(/^"session:\/b" is not a session's address\. For that session, write "b"\./)
    expect(refusal(() => r.ref('a', 'app:x'))).toMatch(/is not a session's address/)
    expect(refusal(() => r.ref('a', 'session: b'))).toMatch(/^"session: b" is not a session's address\. For that session, write "b"\./)
  })

  it('finds a session here named like a refused shape by that name first', () => {
    const r = refs({ sessions: [here('a', 'alpha'), here('s', 'Session: cleanup'), here('f', 'app:fix'), here('v', `session:${HOST}/v1`)] })
    expect(['session: cleanup', 'app:fix', `session:${HOST}/v1`].map((t) => r.ref('a', t))).toEqual([
      { word: 'session: cleanup', here: [here('s', 'Session: cleanup')] },
      { word: 'app:fix', here: [here('f', 'app:fix')] },
      { word: `session:${HOST}/v1`, here: [here('v', `session:${HOST}/v1`)] },
    ])
  })

  it("refuses a session's whole address, which tools no longer print, with the id to write for it", () => {
    const r = refs({ hubs: [{ id: 'hub-0000000b', label: 'studio', name: 'Studio' }] })
    expect(refusal(() => r.ref('a', `session:${HOST}/b`))).toBe(`"session:${HOST}/b" is a mail address, which tools do not take. For that session, write "b". Name a session by its id (<id> here, <computer>.<id> on another computer), its name, or "assistant", "parent" or "person".`)
    expect(refusal(() => r.ref('a', 'session:hub-0000000b/h1'))).toMatch(/^"session:hub-0000000b\/h1" is a mail address, which tools do not take\. For that session, write "studio\.h1"\./)
  })

  it('on a hub, <machine>.<id> is that machine\'s session as this hub names it; a name here comes first, dot or not', () => {
    expect(refs({ machines: ['m1'] }).ref('a', 'm1.w1')).toEqual({ address: `session:${HOST}/m1.w1` })
    expect(refs({ machines: ['m1'], sessions: [here('z', 'm1.w1')] }).ref('a', 'm1.w1')).toEqual({ word: 'm1.w1', here: [here('z', 'm1.w1')] })
    // No such machine: still this hub's, whose mail across says the machine is not linked
    expect(refs({ machines: ['m1'] }).ref('a', 'm2.w1')).toEqual({ address: `session:${HOST}/m2.w1` })
    expect(refs({ machines: ['m1'] }).ref('a', 'v1 .2')).toEqual({ word: 'v1 .2', here: [] })
  })

  it('on a machine, <label>.<id> is a hub\'s own session (by its id too, as older builds printed it), and any other computer is the one hub\'s machine', () => {
    const hub = { id: 'hub-0000000b', label: 'studio', name: 'Studio' }
    const r = refs({ hubs: [hub] })
    expect(r.ref('a', 'studio.h1')).toEqual({ address: 'session:hub-0000000b/h1' })
    expect(r.ref('a', 'hub-0000000b.h1')).toEqual({ address: 'session:hub-0000000b/h1' })
    expect(r.ref('a', 'm2.w1')).toEqual({ address: 'session:hub-0000000b/m2.w1' })
    // This machine's own session as the hub names it
    expect(refs({ hubs: [{ ...hub, you: 'm1' }] }).ref('a', 'm1.b')).toEqual({ word: 'b', here: [here('b', 'beta')] })
    // Several hubs: another machine's id is no hub's to guess
    expect(refs({ hubs: [hub, { id: 'hub-0000000c', label: 'desk', name: 'Desk' }] }).ref('a', 'm2.w1')).toEqual({ address: `session:${HOST}/m2.w1` })
  })

  it('refuses a label two hubs share as ambiguous, naming both computers', () => {
    const r = refs({ hubs: [{ id: 'hub-0000000b', label: 'studio', name: 'Studio' }, { id: 'hub-0000000c', label: 'studio', name: 'Studio 2' }] })
    expect(refusal(() => r.ref('a', 'studio.h1'))).toBe('2 computers that link this one go by studio: "Studio" and "Studio 2". Write to the session by its name.')
  })
})

describe('the id read_session and agent_session take', () => {
  it("a role's session, a session here, and a machine's by name from this hub's mirror", () => {
    const r = refs({ assistant: 'orc', mirror: [entry(`session:${HOST}/m1.w1`, 'worker')] })
    const caller = { id: 'a', askedBy: 'b' }
    expect(['assistant', 'parent', 'beta', 'b', 'worker', 'm1.w1'].map((t) => r.sessionId(caller, t))).toEqual(
      ['orc', 'b', 'b', 'b', 'm1.w1', 'm1.w1'].map((id) => ({ ok: true, id })),
    )
  })

  it("refuses a name a session here and one of this hub's machines both have, as mail does", () => {
    const r = refs({ machines: ['m1'], mirror: [entry(`session:${HOST}/m1.w1`, 'beta')] })
    expect(r.sessionId({ id: 'a', askedBy: null }, 'beta')).toEqual({ ok: false, error: `2 sessions are named "beta": b (idle), m1.w1 (Remote box, idle). Give the id of one.` })
    // An id is the one session, whatever a machine's session is named
    expect(r.sessionId({ id: 'a', askedBy: null }, 'b')).toEqual({ ok: true, id: 'b' })
  })

  it('passes a word that names no session on as it is, for the tool to judge (an archived id, a start request)', () => {
    expect(refs().sessionId({ id: 'a', askedBy: null }, 'ag-1234')).toEqual({ ok: true, id: 'ag-1234' })
  })

  it('says why a role, a name or a computer is not one it can take', () => {
    const r = refs({ sessions: [here('a', 'alpha'), here('b', 'twin'), here('c', 'twin')], hubs: [{ id: 'hub-0000000b', label: 'studio', name: 'Studio' }] })
    const caller = { id: 'a', askedBy: null }
    expect(['assistant', 'parent', 'person', 'twin', 'studio.h1', 'm2.w1', 'session:b'].map((t) => r.sessionId(caller, t))).toEqual([
      { ok: false, error: 'There is no Assistant yet.' },
      { ok: false, error: 'No session on this computer started this one.' },
      { ok: false, error: 'The person is not a session.' },
      { ok: false, error: '2 sessions are named "twin": b (idle), c (idle). Give the id of one.' },
      { ok: false, error: '"studio.h1" is a session on Studio, which this tool does not reach from this computer. Mail reaches a session on another computer.' },
      { ok: false, error: '"m2.w1" is a session on a machine Studio links, which this tool does not reach from this computer. Mail reaches a session on another computer.' },
      { ok: false, error: expect.stringMatching(/^"session:b" is not a session's address\. For that session, write "b"\./) },
    ])
  })
})

describe('the id a tool prints for an address', () => {
  it("is the id here, <machine>.<id> for a hub's machine, and on a machine <label>.<id> for a hub's own session: each reads back as its address", () => {
    const onHub = refs({ machines: ['m1'] })
    const onMachine = refs({ hubs: [{ id: 'hub-0000000b', label: 'studio', name: 'Studio', you: 'm1' }] })
    expect([`session:${HOST}/b`, `session:${HOST}/m1.w1`].map((a) => onHub.shown(a))).toEqual(['b', 'm1.w1'])
    expect(['session:hub-0000000b/h1', 'session:hub-0000000b/m2.w1', 'session:hub-0000000b/m1.b'].map((a) => onMachine.shown(a))).toEqual(['studio.h1', 'm2.w1', 'b'])
    expect(onHub.ref('a', onHub.shown(`session:${HOST}/m1.w1`))).toEqual({ address: `session:${HOST}/m1.w1` })
    expect(['session:hub-0000000b/h1', 'session:hub-0000000b/m2.w1'].map((a) => onMachine.ref('a', onMachine.shown(a)))).toEqual([{ address: 'session:hub-0000000b/h1' }, { address: 'session:hub-0000000b/m2.w1' }])
  })

  it("is the person's word for the person under either name and an app's address as it is; a hub no longer linked goes by its id", () => {
    const r = refs()
    expect(['person', 'session:hub-0000000b/person', `app:${HOST}/p1/x`, 'centralu', 'session:hub-0000000b/h1'].map((a) => r.shown(a))).toEqual(['person', 'person', `app:${HOST}/p1/x`, 'centralu', 'hub-0000000b.h1'])
  })
})
