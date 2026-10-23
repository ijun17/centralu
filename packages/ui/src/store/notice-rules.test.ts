import { describe, expect, it } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'
import { computeInbox } from './selectors.js'

/*
 * Notices with the top-right cards gone (owner, 2026-10-18): a notice is a line the inbox's capsule writes out for a
 * few seconds (InboxPill), so it is made on screen too. A finished turn, an approval, a request to start an agent, a
 * question and an error each leave one, whether or not the session is the one on screen; Notices.tsx clears each by
 * its kind's rule. Each test uses its own session ids: the store is one module for the whole file.
 */

function sessionInfo(id: string): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: `Session ${id}`, autoNamed: true,
    state: 'working', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
    appId: null, ...sessionLiveDefaults(),
  }
}

/** A session that is working, on screen, with the app in front: where the old cards were never made */
async function onScreen(id: string): Promise<MockPlatform> {
  const mock = new MockPlatform()
  mock.sessions.set(id, sessionInfo(id))
  await useStore.getState().attach(mock)
  useStore.setState({ appFocused: true, view: 'focus', focusedSessionId: id, notices: [] })
  return mock
}

const noticesOf = (id: string) => useStore.getState().notices.filter((n) => n.sessionId === id)
const send = (e: object) => useStore.getState().dispatchEvent(e as NormalizedEvent)

describe('a notice is made for the session on screen too', () => {
  it('when its turn finishes, beside the sweep on screen', async () => {
    await onScreen('nr-done')
    send({ type: 'turn_complete', sessionId: 'nr-done' })
    expect(noticesOf('nr-done')).toEqual([expect.objectContaining({ kind: 'done', name: 'Session nr-done' })])
    expect(useStore.getState().completion).toMatchObject({ sessionId: 'nr-done' })
  })

  it('not when the turn was Centralu compacting the conversation (#1451): nothing finished that the person waits for', async () => {
    await onScreen('nr-compact')
    send({ type: 'turn_complete', sessionId: 'nr-compact', turn: { by: 'work', compaction: true } })
    expect(noticesOf('nr-compact')).toEqual([])
    expect(useStore.getState().completion?.sessionId).not.toBe('nr-compact')
  })

  it('when it asks for an approval', async () => {
    await onScreen('nr-appr')
    send({ type: 'approval_request', sessionId: 'nr-appr', requestId: 'r1', detail: { kind: 'command', command: 'make' } })
    expect(noticesOf('nr-appr')).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('when it asks to start an agent, in its own words', async () => {
    await onScreen('nr-agent')
    send({
      type: 'approval_request',
      sessionId: 'nr-agent',
      requestId: 'r2',
      detail: { kind: 'agent_start', project: { id: 'p1', name: 'web' }, tool: 'claude', preset: 'normal', text: 'fix the build' },
    })
    expect(noticesOf('nr-agent')).toEqual([expect.objectContaining({ kind: 'agent_start' })])
  })

  it('when the agent asks the person a question', async () => {
    await onScreen('nr-q')
    send({
      type: 'question_request',
      sessionId: 'nr-q',
      requestId: 'q1',
      questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: '' }], multiSelect: false }],
    })
    expect(noticesOf('nr-q')).toEqual([expect.objectContaining({ kind: 'question' })])
  })

  it('and a question keeps its own words with the app behind, where the banner rule applies', async () => {
    await onScreen('nr-q2')
    useStore.setState({ appFocused: false, focusedSessionId: null })
    send({
      type: 'question_request',
      sessionId: 'nr-q2',
      requestId: 'q2',
      questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: '' }], multiSelect: false }],
    })
    expect(noticesOf('nr-q2')).toEqual([expect.objectContaining({ kind: 'question' })])
  })

  it('when it falls into an error', async () => {
    await onScreen('nr-err')
    send({ type: 'state_change', sessionId: 'nr-err', state: 'error', reason: 'crashed' })
    expect(noticesOf('nr-err')).toEqual([expect.objectContaining({ kind: 'error' })])
  })
})

describe('the inbox lists a question the agent asked', () => {
  it('as it lists an approval, until it is answered', async () => {
    await onScreen('nr-inbox')
    const question = { requestId: 'q9', questions: [{ question: 'Which one?', header: 'Pick', options: [], multiSelect: false }] }
    useStore.setState((s) => ({
      sessions: { ...s.sessions, 'nr-inbox': { ...s.sessions['nr-inbox']!, state: 'idle', pendingQuestions: [question] as never } },
    }))
    expect(computeInbox(useStore.getState()).find((i) => i.id === 'nr-inbox')).toMatchObject({ state: 'waiting_approval' })

    useStore.setState((s) => ({
      sessions: { ...s.sessions, 'nr-inbox': { ...s.sessions['nr-inbox']!, pendingQuestions: [] } },
    }))
    expect(computeInbox(useStore.getState()).find((i) => i.id === 'nr-inbox')?.state).not.toBe('waiting_approval')
  })
})
