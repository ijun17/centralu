/**
 * Store regression tests: handing off and starting fresh.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { SLOW } from '../../../../tooling/test-timing.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineInfo, NormalizedEvent } from '@cc/protocol'
import { sessionGridPanel } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { handoffPrompt, useStore } from './store.js'
import { line, readAll, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/**
 * Pretends the predecessor wrote its note **as a reply** (#142) — the host (mocked) places the file at
 * the note's spot in the data folder. What is returned is that location. The path is keyed to the
 * departing session's id (#104).
 */
function mockNote(mock: MockPlatform, sessionId: string, text: string): string {
  mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text } as NormalizedEvent)
  return notePathOf(mock, sessionId)
}
const notePathOf = (mock: MockPlatform, sessionId: string) =>
  `/mock-data/handoff/${mock.sessions.get(sessionId)!.projectId}/${sessionId}.md`

/**
 * A note a pre-#142 handoff left in the user's repository — an old successor session still holds this
 * path. The app never reads it, overwrites it, or clears it away.
 */
function oldRepoNote(mock: MockPlatform, sessionId: string): string {
  const path = `.centralu/handoff/${sessionId}.md`
  mock.placeFile(path, 'note from the old spot')
  return path
}

/** Traces of a handoff file being newly placed or cleared from the user's repository (#142) — there must be nothing but the old note */
const repoHandoffTraces = (mock: MockPlatform, old: string) => [
  ...Object.keys(mock.fsState.files).filter((p) => p.includes('handoff') && p !== old),
  ...(mock.fsState.files[old] === 'note from the old spot' ? [] : [`${old} changed`]),
  ...mock.trashed.filter((p) => p.includes('handoff')),
]

describe('handing off and starting fresh', () => {
  it('makes a new session from the note, hands on the name, and moves the original to the session archive (#204)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho1')
    mock.sessions.set('ho-s1', sessionInfo('ho-s1', { projectId: proj.id, name: 'Mea', model: 'gpt-5.6', tool: 'codex', externalId: 'rollout-1' }))
    const old = oldRepoNote(mock, 'ho-s1')
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s1', { mode: 'agent' })
    // A handoff request is never hidden — it enters as the session's own ordinary message
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s1'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    // The dying session writes its text **as the reply** (#142) — the host reads it from the record after that turn ends and places it as a file
    const notePath = mockNote(mock, 'ho-s1', 'To my successor: status summary')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s1', state: 'waiting_input' } as NormalizedEvent)
    await done

    /*
     * The new session's first message is **the note's location, not the note** (#102). A preview is
     * carried, but not the full text — the prompt's promise that length is not a constraint is only
     * true inside the file.
     */
    expect(mock.lastCreateParams?.initialPrompt).toContain(notePath)
    expect(mock.handoffNotes.get(notePath)).toBe('To my successor: status summary')
    expect(mock.lastCreateParams?.initialPrompt).toContain('To my successor: status summary') // Preview
    // Nothing was written to or cleared from the user's repository — even the old note's location is untouched (#142)
    expect(repoHandoffTraces(mock, old)).toEqual([])
    // The full text goes into the record — the only material that can never be recreated once the predecessor is gone
    // Its id goes along too (#106) — this is how the host's cleanup knows this note still has an owner
    // and that the original goes next (#738), so the host gives the new session every child, settled ones too
    expect(mock.lastCreateParams?.handoff).toEqual({ from: 'Mea', note: 'To my successor: status summary', fromSessionId: 'ho-s1', removesOriginal: true })
    expect(mock.lastCreateParams?.tool).toBe('codex')
    expect(mock.lastCreateParams?.model).toBe('gpt-5.6')
    const heir = [...mock.sessions.values()].find((r) => r.name === 'Mea')
    expect(heir).toBeDefined()
    expect(heir!.id).not.toBe('ho-s1')
    // The screen's summary also shows the inherited settings immediately — if it is only in the database while the menu says Default, it reads as "never carried over" (dogfooding)
    expect(useStore.getState().sessions[heir!.id]).toMatchObject({ model: 'gpt-5.6', effort: null })
    // The old session is in the session archive (#204), its tool file marked to go when it is deleted for good
    expect(mock.sessions.has('ho-s1')).toBe(false)
    expect(mock.externallyDeleted).not.toContain('ho-s1')
    expect((await mock.trash.list()).sessions.find((x) => x.id === 'ho-s1')?.conversationFile).toBe('remove')
    // The screen is looking at the new session
    expect(useStore.getState().focusedSessionId).toBe(heir!.id)
  })

  // #841 item 5: a note the host could not write read as "no note yet" and was polled for ten minutes
  it('stops at once and says why when the host cannot save the note', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-fail')
    mock.sessions.set('ho-f1', sessionInfo('ho-f1', { projectId: proj.id, name: 'Mea' }))
    mock.agents.exportHandoffNote = async () => {
      throw new Error('EACCES: permission denied')
    }
    await useStore.getState().attach(mock)
    const before = mock.sessions.size

    const done = useStore.getState().handoffSession('ho-f1', { mode: 'agent' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-f1'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mock.emit({ type: 'turn_complete', sessionId: 'ho-f1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-f1', state: 'waiting_input' } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().toast).toContain('could not save the handoff note: EACCES: permission denied'), { timeout: 5_000 * SLOW })
    await done
    expect(mock.sessions.size).toBe(before)
    expect(mock.sessions.has('ho-f1')).toBe(true)
  })

  it('inherits the grid slot — the successor stands at the same index, and the order does not shift', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho7')
    mock.sessions.set('ho-g1', sessionInfo('ho-g1', { projectId: proj.id }))
    mock.sessions.set('ho-g2', sessionInfo('ho-g2', { projectId: proj.id, name: 'Middle' }))
    mock.sessions.set('ho-g3', sessionInfo('ho-g3', { projectId: proj.id }))
    await mock.agents.setGridView(['ho-g1', 'ho-g2', 'ho-g3'].map(sessionGridPanel))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-g2', { mode: 'agent' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-g2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-g2', 'Please continue')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-g2' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-g2', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === 'Middle' && r.id !== 'ho-g2')!
    // The middle panel keeps its successor in place — a panel disappearing and reappearing would scramble the arrangement (dogfooding)
    expect(useStore.getState().gridPanels).toEqual(['ho-g1', heir.id, 'ho-g3'].map(sessionGridPanel))
    expect(useStore.getState().focusedSessionId).toBe(heir.id)
  })

  /*
   * Record mode (#78): asking an agent whose service has been cut off for a note is asking a
   * counterpart who cannot respond for a will — the host builds the record from the store's own
   * transcript and **asks the dead session nothing at all**.
   */
  it('record mode asks the dead session nothing, and leaves the original by default (#78)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-rec')
    mock.sessions.set('ho-r1', sessionInfo('ho-r1', { projectId: proj.id, name: 'Dead Mea', tool: 'codex', state: 'error' }))
    const old = oldRepoNote(mock, 'ho-r1')
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-r1', { mode: 'record', tool: 'claude' })

    // No message went out to the dead session — this is the whole reason this mode exists
    expect((useStore.getState().chat['ho-r1'] ?? []).some((i) => i.kind === 'user')).toBe(false)
    // The record also lands at **the same location** (#102) — only the producer differs, and what the successor receives is identical
    expect(mock.handoffNotes.get(notePathOf(mock, 'ho-r1'))).toContain('Handoff Record')
    expect(mock.lastCreateParams?.initialPrompt).toContain(notePathOf(mock, 'ho-r1'))
    expect(repoHandoffTraces(mock, old)).toEqual([]) // The user's repository is never touched (#142)
    expect(mock.lastCreateParams?.initialPrompt).toContain('Handoff Record') // Preview
    expect(mock.lastCreateParams?.handoff?.note).toContain('Handoff Record')
    expect(mock.lastCreateParams?.tool).toBe('claude')
    // The original survives — record mode's default is to preserve it (until the successor is confirmed)
    expect(mock.sessions.has('ho-r1')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-r1')
    // The name is inherited
    expect([...mock.sessions.values()].some((r) => r.name === 'Dead Mea' && r.id !== 'ho-r1')).toBe(true)
  })

  /*
   * The note comes from the record unless the caller asks the agent (owner decision on #694): a live session that
   * could answer is still not asked, since it is the one least likely to summarize itself correctly.
   */
  it('builds the note from the record by default, even for a live session, and keeps the original (#694)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-default')
    mock.sessions.set('ho-d1', sessionInfo('ho-d1', { projectId: proj.id, name: 'Live Mea', tool: 'claude', state: 'idle' }))
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-d1')

    expect((useStore.getState().chat['ho-d1'] ?? []).some((i) => i.kind === 'user')).toBe(false)
    expect(mock.lastCreateParams?.handoff?.note).toContain('Handoff Record')
    expect(mock.lastCreateParams?.tool).toBe('claude')
    expect(mock.sessions.has('ho-d1')).toBe(true)
    expect(mock.lastCreateParams?.handoff?.removesOriginal).toBeUndefined()
  })

  it('deletes nothing if the session errors while writing — destruction only follows success', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho2')
    mock.sessions.set('ho-s2', sessionInfo('ho-s2', { projectId: proj.id, name: 'Mea 2' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s2', { mode: 'agent' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mock.emit({ type: 'state_change', sessionId: 'ho-s2', state: 'error' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s2')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-s2')
    expect(useStore.getState().toast).toMatch(/Handoff failed/)
  })

  it('handing off to a different agent never carries over tool-specific settings', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho5')
    mock.sessions.set('ho-s5', sessionInfo('ho-s5', { projectId: proj.id, name: 'Switching', tool: 'codex', model: 'gpt-5.6', effort: 'high' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s5', { mode: 'agent', tool: 'claude' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s5'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s5', 'note')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s5' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s5', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.lastCreateParams?.tool).toBe('claude')
    // Passing codex's model and effort to claude kills session creation outright — never carried over
    expect(mock.lastCreateParams?.model).toBeUndefined()
    expect(mock.lastCreateParams?.effort).toBeUndefined()
    expect(mock.sessions.has('ho-s5')).toBe(false) // The delete default is still on
  })

  it('turning off deletion leaves the old session standing — a branch, not a switch', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho6')
    mock.sessions.set('ho-s6', sessionInfo('ho-s6', { projectId: proj.id, name: 'Branch' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s6', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s6'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s6', 'branch note')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s6' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s6', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s6')).toBe(true) // The old session survives
    // It keeps its settled children: the host is not told the original goes (#738)
    expect(mock.lastCreateParams?.handoff).not.toHaveProperty('removesOriginal')
    expect(mock.externallyDeleted).not.toContain('ho-s6')
    expect([...mock.sessions.values()].filter((r) => r.name === 'Branch').length).toBe(2)
  })

  it('a running turn\'s report never mixes into the top of the note — the request waits for the turn to end (measured in the Mea session)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho4')
    mock.sessions.set('ho-s4', sessionInfo('ho-s4', { projectId: proj.id, name: 'Mea 4', state: 'working' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s4', { mode: 'agent' })
    // The running turn has not ended yet — the prompt is never sent, only that turn's report streams in
    await new Promise((r) => setTimeout(r, 700))
    mock.emit({ type: 'message_delta', sessionId: 'ho-s4', role: 'assistant', text: 'Applied: report on the previous task' } as NormalizedEvent)
    expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(false)

    // Only once the turn ends is the request finally sent
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s4', '# 1. Project and objective')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await done

    // The report from the previous turn is not in the text — a handoff starting with "Applied:" was exactly that incident
    expect(mock.lastCreateParams?.handoff?.note).toBe('# 1. Project and objective')
    expect(mock.lastCreateParams?.initialPrompt).not.toContain('Applied:')
  })

  /*
   * #102: the predecessor was told "it is a file, so length is not a constraint" and then the result
   * was delivered as a single chat message — the longer it got, the more thorough the note, and the
   * more thorough, the more likely the successor died the moment it arrived (measured: handing a long
   * session off to codex produced an error). The first message now points at the note's **location**
   * instead, so no matter how long the note grows, the first message never grows with it.
   */
  it('even a long note never becomes a huge first message — what is handed over is a path, not the content (#102)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-big')
    mock.sessions.set('ho-big', sessionInfo('ho-big', { projectId: proj.id, name: 'a session that lived long' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-big', { mode: 'agent' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-big'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const huge = '# 1. Project and objective\n' + 'This session ran long, and the note is just as long. '.repeat(20_000)
    const bigPath = mockNote(mock, 'ho-big', huge)
    mock.emit({ type: 'turn_complete', sessionId: 'ho-big' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-big', state: 'waiting_input' } as NormalizedEvent)
    await done

    const prompt = mock.lastCreateParams!.initialPrompt!
    // The note is over 500,000 characters, but the first message fits on one screen — that gap is exactly what this fix is
    expect(huge.length).toBeGreaterThan(500_000)
    expect(prompt.length).toBeLessThan(2_000)
    expect(prompt).toContain(bigPath)
    expect(prompt).toContain('# 1. Project and objective') // A preview is there
    // And the note is never lost — its full text lives somewhere that outlives the file (the record)
    const kept = mock.lastCreateParams?.handoff?.note ?? ''
    expect(kept).toHaveLength(huge.trim().length)
    expect(kept.endsWith('the note is just as long.')).toBe(true)
  })

  /*
   * #106: cleanup used to hang off a turn boundary — **the instant the successor's first turn ends.**
   * That condition asks neither whether the turn succeeded nor whether the note was ever read. In an
   * actual incident, the first turn died with a 400 in under a second, and the directory was empty
   * within three minutes. The successor was holding a path to a file that no longer existed, and that
   * text could never be recreated, since the session that wrote it had just been replaced.
   */
  it('the note survives even if the first turn fails — nothing is ever cleared at a turn boundary (#106)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-sweep')
    mock.sessions.set('ho-sw', sessionInfo('ho-sw', { projectId: proj.id, name: 'Cleanup' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-sw', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-sw'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const notePath = mockNote(mock, 'ho-sw', 'text that must not disappear before it is read')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-sw' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-sw', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === 'Cleanup' && r.id !== 'ho-sw')!
    // The first turn dies with a 400 — the note used to disappear right here
    mock.emit({
      type: 'error', sessionId: heir.id,
      error: { code: 'internal', message: "The 'opus[1m]' model is not supported", retryable: true },
    } as NormalizedEvent)
    // Same result even with a successful turn — the reasoning was "was it read," which cannot be observed
    mock.emit({ type: 'turn_complete', sessionId: heir.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))

    expect(mock.handoffNotes.get(notePath)).toBe('text that must not disappear before it is read')
  })

  /*
   * #104: running several sessions at once in one project is the whole reason this app exists, yet the
   * handoff file was one per project. So two handoffs running at the same time would (1) write to the
   * same location, letting whichever wrote later win — the one waiting quietly received a note with
   * the right shape and the wrong content — and (2) have the successor that finished its first turn
   * first clear away someone else's text with its cleanup.
   */
  it('two handoffs in the same project never overwrite or clear each other\'s text (#104)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-pair')
    mock.sessions.set('ho-a', sessionInfo('ho-a', { projectId: proj.id, name: 'Left' }))
    mock.sessions.set('ho-b', sessionInfo('ho-b', { projectId: proj.id, name: 'Right' }))
    await useStore.getState().attach(mock)

    // Both are started side by side — doing them one after the other would never surface this bug at all
    const a = useStore.getState().handoffSession('ho-a', { mode: 'agent', deleteOld: false })
    const b = useStore.getState().handoffSession('ho-b', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-a'] ?? []).some((i) => i.kind === 'user')).toBe(true)
      expect((useStore.getState().chat['ho-b'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const pathA = mockNote(mock, 'ho-a', "Left's note")
    const pathB = mockNote(mock, 'ho-b', "Right's note")
    for (const id of ['ho-a', 'ho-b']) {
      mock.emit({ type: 'turn_complete', sessionId: id } as NormalizedEvent)
      mock.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' } as NormalizedEvent)
    }
    await Promise.all([a, b])

    // Each received its own predecessor's text — when there was one filename, both received whichever one was written last
    const paramsOf = (from: string) => mock.createParamsLog.find((x) => x.handoff?.from === from)
    expect(paramsOf('Left')?.handoff?.note).toBe("Left's note")
    expect(paramsOf('Right')?.handoff?.note).toBe("Right's note")
    expect(paramsOf('Left')?.initialPrompt).toContain(pathA)
    expect(paramsOf('Right')?.initialPrompt).toContain(pathB)

    /*
     * Even after one successor's first turn ends, **no text disappears** (#106). While cleanup hung
     * off a turn, whichever finished first cleared away someone else's text (what #104 fixed); now not
     * even its own predecessor's text is cleared here — there is no way to tell whether it was read.
     */
    const heirA = [...mock.sessions.values()].find((r) => r.name === 'Left' && r.id !== 'ho-a')!
    mock.emit({ type: 'turn_complete', sessionId: heirA.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))
    expect(pathA).not.toBe(pathB)
    expect(mock.handoffNotes.get(pathA)).toBe("Left's note")
    expect(mock.handoffNotes.get(pathB)).toBe("Right's note")
  })

  /*
   * The counterpart of #104 (#142): the old wait loop only checked "the file exists and is not
   * empty," so a file left behind by a past failed handoff was delivered as if it were the freshly
   * written note. Now that the note is a reply, the same trap becomes **the reply to a past request.**
   * A failed handoff leaves the same request and its reply sitting in the conversation, and the host
   * reads "the last reply after the request" as the note. Finding the request by taking the first one
   * makes that old reply the note.
   */
  it('a reply left by a past failure is never mistaken for a freshly written note (#104, #142)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-stale')
    mock.sessions.set('ho-st', sessionInfo('ho-st', { projectId: proj.id, name: 'an old spot' }))
    await useStore.getState().attach(mock)

    // A handoff that failed previously: the same request and its reply are already in the conversation
    mock.emit({ type: 'user_message', sessionId: 'ho-st', seq: 1, text: handoffPrompt() } as NormalizedEvent)
    mockNote(mock, 'ho-st', 'an old note left by a failed handoff last month')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)

    const done = useStore.getState().handoffSession('ho-st', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-st'] ?? []).filter((i) => i.kind === 'user').length).toBe(2)
    })
    // The predecessor ended this turn without answering anything — exactly the moment the old text used to be delivered
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 1_500))
    expect(mock.createParamsLog).toEqual([]) // No successor is born — there is nothing yet for it to receive

    // Only once the real note arrives does it proceed
    mockNote(mock, 'ho-st', 'a new note just written')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)
    await done
    expect(mock.lastCreateParams?.handoff?.note).toBe('a new note just written')
  })

  /*
   * #142: the note's location is the first human message after "the last recorded point right before
   * the request." If that point is measured by the screen's `lastSeq`, then while the confirmation
   * (`user_message`) for a message sent earlier has not yet arrived, `lastSeq` does not count that
   * message and lags behind — so the first human message after that lagging point is the earlier
   * message, and the request becomes "the next human message," so the reply is never read as the note
   * (this actually stalled in e2e).
   */
  it('never misses the request\'s point even when a previously sent message has not been confirmed yet (#142)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-lag')
    mock.sessions.set('ho-lag', sessionInfo('ho-lag', { projectId: proj.id, name: 'late confirmation' }))
    await useStore.getState().attach(mock)
    // A person spoke first and the turn ended — the mock never sends that message's confirmation (the screen's lastSeq does not know about it)
    await useStore.getState().send('ho-lag', 'the thing said first')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-lag' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-lag', state: 'waiting_input' } as NormalizedEvent)

    const done = useStore.getState().handoffSession('ho-lag', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-lag'] ?? []).filter((i) => i.kind === 'user').length).toBe(2)
    })
    mockNote(mock, 'ho-lag', "the late confirmation's note")
    mock.emit({ type: 'turn_complete', sessionId: 'ho-lag' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-lag', state: 'waiting_input' } as NormalizedEvent)
    await done
    expect(mock.lastCreateParams?.handoff?.note).toBe("the late confirmation's note")
  })

  it('filters out worktree sessions — a worktree\'s lifetime is bound to its session', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho3')
    mock.sessions.set(
      'ho-s3',
      sessionInfo('ho-s3', { projectId: proj.id, worktree: { path: '/tmp/wt', branch: 'centralu/x' } }),
    )
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-s3')

    expect(mock.sessions.has('ho-s3')).toBe(true)
    expect((useStore.getState().chat['ho-s3'] ?? []).length).toBe(0)
    expect(useStore.getState().toast).toMatch(/Worktree sessions/)
  })
})

/*
 * #172: the host broadcasts `session_created`, `handoff` and `user_message`, in that order, before the
 * response, while creating a session. The screen registers the session from the first one and attaches
 * the other two to the conversation, but the returned response used to overwrite the conversation with
 * a single pending opening prompt, erasing the marker. Reading history brought the marker back, so the
 * opening prompt stood twice. The mock now broadcasts in the same order as the host.
 */
describe('the first screen of a session born from a handoff (#172)', () => {
  it('exactly one marker and one opening prompt stand, and reading back through history leaves them as is', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho172')
    await useStore.getState().attach(mock)
    // The history page arrives one round trip late — the merge with history (#197) sees the screen before the response's overwrite covers it
    const load = mock.agents.loadMessages.bind(mock.agents)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(mock.agents, 'loadMessages').mockImplementation(async (...a) => {
      await gate
      return load(...a)
    })

    const info = await useStore.getState().createSession(proj.id, {
      initialPrompt: 'OPENING',
      handoff: { from: 'Old', note: 'note', fromSessionId: 'old-172' },
    })
    const now = () => useStore.getState().chat[info.id] ?? []
    expect(now().map(line)).toEqual([expect.stringContaining('Handed off from "Old"'), 'OPENING'])
    // The opening prompt is a confirmed row — leaving it pending would let it absorb a later message with the same text
    expect(now().find((i) => i.kind === 'user' && i.pending)).toBeUndefined()

    release()
    expect(await readAll(info.id)).toEqual([expect.stringContaining('Handed off from "Old"'), 'OPENING', ...now().slice(2).map(line)])
    expect(now().filter((i) => i.kind === 'user' && i.text === 'OPENING')).toHaveLength(1)
    expect(now().filter((i) => i.kind === 'mark')).toHaveLength(1)
  })
})

// #1822: a machine whose link drops shows its session as not working; the hand-off still waits for it, as before
describe('handing off a session of a linked machine whose link drops', () => {
  const box = (over: Partial<MachineInfo> = {}): MachineInfo => ({
    id: 'box', name: 'Box', sshTarget: 'me@box', shell: 'posix', wslDistro: null, command: null, status: 'connected',
    error: null, versions: null, lastConnectedAt: null, nextAttemptAt: null, localPort: null, sameLocalPort: false, hostStarted: null, install: null, operation: null, autostart: null, elevated: null, asks: null, logon: null, handover: null, autoReconnect: true, otherCredentials: null, otherCredentialsMore: 0, ownCredentialGone: false, credentialFileUnreadable: false, ...over,
  })
  const sent = () => (useStore.getState().chat['box.ho-m1'] ?? []).some((i) => i.kind === 'user')
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('neither sends the request nor asks for the note while the machine is away', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    const proj = await mock.projects.add('/srv/ho-m', 'box')
    mock.sessions.set('box.ho-m1', sessionInfo('box.ho-m1', { projectId: proj.id, machine: 'box', name: 'Far', state: 'working' }))
    await useStore.getState().attach(mock)
    const asked = vi.spyOn(mock.agents, 'exportHandoffNote')

    const done = useStore.getState().handoffSession('box.ho-m1', { mode: 'agent' })
    // Its turn ran on when the link dropped: the request waits, though the row no longer says working
    mock.emit({ type: 'machine_status', machine: box({ status: 'unreachable' }) })
    expect(useStore.getState().sessions['box.ho-m1']!.state).toBe('idle')
    await pause(1_200)
    expect(sent()).toBe(false)
    // Back, its turn over: the request goes
    mock.sessions.get('box.ho-m1')!.state = 'waiting_input'
    mock.emit({ type: 'machine_status', machine: box() })
    mock.emit({ type: 'machine_resync', machineId: 'box' })
    await vi.waitFor(() => expect(sent()).toBe(true), { timeout: 5_000 * SLOW })
    // The link drops while the note is written: the note is not asked for until it is back
    mock.emit({ type: 'machine_status', machine: box({ status: 'unreachable' }) })
    const calls = asked.mock.calls.length
    await pause(1_200)
    expect(asked.mock.calls.length).toBe(calls)
    mock.emit({ type: 'machine_status', machine: box() })
    mockNote(mock, 'box.ho-m1', 'note from far')
    mock.emit({ type: 'turn_complete', sessionId: 'box.ho-m1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'box.ho-m1', state: 'waiting_input' } as NormalizedEvent)
    await done
    expect(mock.lastCreateParams?.handoff).toMatchObject({ note: 'note from far' })
  })
})
