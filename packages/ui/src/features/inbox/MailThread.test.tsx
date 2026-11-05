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

  it('names the conversation, its state and who it is between, with a way to open each session in it, and reads no Next line even from a host that sends one', () => {
    const { html, text } = render(view())
    expect(text).toContain('Land #12')
    expect(text).toContain('Running')
    expect(text).toContain('You → Parser')
    expect(text).not.toContain('Next:')
    expect(text).not.toContain('write the parser')
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

  it('draws a script’s message under the script’s label, not as the person’s own (§8.1)', () => {
    const { html, text } = render(
      view({
        messages: [{ id: 'm1', seq: 1, sender: you, kind: 'assign', urgent: false, body: 'Triage the build', facts: { fromScript: { credential: 'ci runner' } }, createdAt: 1_800_000_000_000 }],
      }),
    )
    expect(text).toContain('script ci runner · assign')
    expect(text).not.toContain('You · assign')
    // Drawn on the left, as another party's, not on the right as the person's
    expect(/<li class="[^"]*items-start[^"]*" data-testid="mail-message-1"/.test(html)).toBe(true)
  })

  it('offers the earlier messages when a long thread was opened at its end, and not otherwise', () => {
    expect(render(view({ older: true })).html).toContain('data-testid="mail-earlier"')
    expect(render(view()).html).not.toContain('data-testid="mail-earlier"')
  })

  it('offers no way to give the work to another session and draws no blocker, even from a host of an older build that sends one', () => {
    const { html, text } = render(view({ blockers: [{ n: 1, kind: 'text', ref: null, text: 'waiting for a design', resolved: false }] }))
    expect(html).not.toContain('data-testid="mail-give"')
    expect(html).not.toContain('data-testid="mail-reassign"')
    expect(html).not.toContain('data-testid="mail-blockers"')
    expect(text).not.toContain('Give to another session')
    expect(text).not.toContain('waiting for a design')
    expect(text).not.toContain('Unblock')
  })

  it('has a reply box and the person’s acts while it is open, and neither once it is done', () => {
    const open = render(view())
    expect(open.html).toContain('data-testid="mail-reply"')
    expect(open.html).toContain('data-testid="mail-finish"')
    const done = render(view({ thread: { ...view().thread, state: 'done', outcome: 'finished' } }))
    expect(done.html).not.toContain('data-testid="mail-reply"')
    expect(done.html).not.toContain('data-testid="mail-finish"')
    expect(done.text).toContain('This is done')
    expect(done.text).not.toContain('thread')
  })

  it('offers no reply box on a chain with nothing of the person’s to answer (mail between sessions held for them), and keeps the acts; a host that does not say has the box', () => {
    const held = render(view({ canReply: false }))
    expect(held.html).not.toContain('data-testid="mail-reply"')
    expect(held.html).not.toContain('data-testid="mail-send"')
    expect(held.html).toContain('data-testid="mail-finish"')
    expect(render(view({ canReply: true })).html).toContain('data-testid="mail-reply"')
    expect(render(view()).html).toContain('data-testid="mail-reply"')
  })

  it('words the reply box as a reply, and the person never reads the word thread', () => {
    const open = render(view({ more: true }))
    expect(open.html).toContain('placeholder="Reply"')
    expect(open.html).toContain('aria-label="Your reply"')
    expect(open.text).not.toMatch(/thread/i)
  })
})
