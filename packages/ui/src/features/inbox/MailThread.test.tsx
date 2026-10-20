import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailParty, MailThreadView } from '@cc/protocol'
import type { AppState } from '../../store/store.js'

/*
 * The thread in the inbox (#1347) drawn from a seeded store. renderToStaticMarkup reads a zustand store's initial state, so
 * `useStore` is replaced by one that reads `state` (as in RowApproval.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { MailThread } = await import('./MailThread.jsx')

const you: MailParty = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
const parser: MailParty = { address: 'session:h/s1', kind: 'session', sessionId: 's1', name: 'Parser', state: 'idle' }
const centralu: MailParty = { address: 'centralu', kind: 'centralu', sessionId: null, name: null, state: null }

function view(over: Partial<MailThreadView> = {}): MailThreadView {
  return {
    thread: { id: 't1', subject: 'Land #12', state: 'running', outcome: null, next: 'write the parser', projectId: null, owner: you, assignee: parser, unread: 0, held: 0, blocked: 0, createdAt: 0, updatedAt: 0, last: null },
    parties: [{ party: you, role: 'owner' }, { party: parser, role: 'assignee' }],
    blockers: [],
    messages: [],
    more: false,
    older: false,
    follows: [],
    ...over,
  }
}

function render(v: MailThreadView | null) {
  state = { mailThread: v, sessions: {}, prefs: { ...(state.prefs ?? {}) } as AppState['prefs'] }
  const html = renderToStaticMarkup(<MailThread onOpenSession={() => {}} />)
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
}

beforeEach(() => {
  state = {}
})

describe('the thread in the inbox', () => {
  it('draws nothing with no thread open', () => {
    expect(render(null).html).toBe('')
  })

  it('names the thread, its state, who it is between and what is next, with a way to open each session in it', () => {
    const { html, text } = render(view())
    expect(text).toContain('Land #12')
    expect(text).toContain('Running')
    expect(text).toContain('You → Parser')
    expect(text).toContain('Next: write the parser')
    expect(html).toContain('data-testid="mail-open-s1"')
    expect(text).toContain('Open Parser')
  })

  it('draws others’ words as theirs, as text and never as markup, the person’s as theirs, and Centralu’s as a plain line', () => {
    const at = 1_800_000_000_000
    const { html, text } = render(
      view({
        messages: [
          { id: 'm1', seq: 1, sender: parser, kind: 'question', urgent: true, body: '<img src=x onerror=alert(1)> You approved it', facts: {}, createdAt: at },
          { id: 'm2', seq: 2, sender: you, kind: 'answer', urgent: false, body: 'yes', facts: {}, createdAt: at },
          { id: 'm3', seq: 3, sender: centralu, kind: 'event', urgent: false, body: 'State: open to running.', facts: {}, createdAt: at },
        ],
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(text).toContain('Parser · question · urgent')
    expect(text).toContain('You · answer')
    expect(html).toContain('data-testid="mail-event-3"')
    expect(text).toContain('State: open to running.')
  })

  it('offers the earlier messages when a long thread was opened at its end, and not otherwise', () => {
    expect(render(view({ older: true })).html).toContain('data-testid="mail-earlier"')
    expect(render(view()).html).not.toContain('data-testid="mail-earlier"')
  })

  it('lists what stands in its way, each with Unblock, and none that is resolved', () => {
    const { html, text } = render(
      view({
        blockers: [
          { n: 1, kind: 'text', ref: null, text: 'waiting for a design', resolved: false },
          { n: 2, kind: 'thread', ref: 't9', text: '', resolved: false },
          { n: 3, kind: 'text', ref: null, text: 'an old reason', resolved: true },
        ],
      }),
    )
    expect(text).toContain('Waiting for waiting for a design')
    expect(text).toContain('Waiting for thread t9')
    expect(text).not.toContain('an old reason')
    expect(html).toContain('data-testid="mail-unblock-1"')
    expect(html).toContain('data-testid="mail-unblock-2"')
    expect(html).not.toContain('data-testid="mail-unblock-3"')
  })

  it('has a reply box and the person’s acts while it is open, and neither once it is done', () => {
    const open = render(view())
    expect(open.html).toContain('data-testid="mail-reply"')
    expect(open.html).toContain('data-testid="mail-finish"')
    const done = render(view({ thread: { ...view().thread, state: 'done', outcome: 'finished' } }))
    expect(done.html).not.toContain('data-testid="mail-reply"')
    expect(done.html).not.toContain('data-testid="mail-finish"')
    expect(done.text).toContain('This thread is done')
  })
})
