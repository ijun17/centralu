import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDetail } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import type { AppState } from '../../store/store.js'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/*
 * The row's approval line (#543) drawn from a seeded session. renderToStaticMarkup reads a zustand store's initial
 * state, so `useStore` is replaced by one that reads `state` (as in ChatRow.test.tsx).
 */
let state: Partial<AppState> = {}
vi.mock('../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { RowApproval, rowAnswerFor, rowsKey, rowSummary, tooltipText } = await import('./RowApproval.jsx')

// Only what the row reads from the platform: the key names its Kbd prints
const platform = { capabilities: { shortcutKeys: { mod: '⌘', alt: '⌥' } } } as unknown as Platform

beforeEach(() => {
  state = {}
})

const command = (c: string): ApprovalDetail => ({ kind: 'command', command: c, cwd: '/work/site' })

function waiting(detail: ApprovalDetail, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    name: 'Clean up',
    state: 'waiting_approval',
    pendingApproval: { requestId: 'r7', detail },
    pendingQuestions: [],
    ...over,
  } as SessionSummary
}

function render(session: SessionSummary | null, props: { settled?: boolean; keys?: boolean } = {}) {
  state = { sessions: session ? { [session.id]: session } : {}, approvalsInFlight: {} }
  const html = renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <RowApproval sessionId="s1" place="inbox" onOpen={() => {}} {...props} />
    </PlatformProvider>,
  )
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
}

const button = (html: string, part: string) => new RegExp(`<button[^>]*data-testid="inbox-${part}-s1"[^>]*>`).exec(html)?.[0] ?? null

describe('RowApproval', () => {
  it('shows the verb and the command, and Allow and Deny that carry the request id the row was drawn from', () => {
    const { html, text } = render(waiting(command('kill -TERM 40321')), { settled: true })
    expect(text).toContain('Run kill -TERM 40321')
    expect(html).toContain('data-request="r7"')
    expect(button(html, 'approve-allow')).toContain('aria-label="Allow run kill -TERM 40321 in Clean up"')
    expect(button(html, 'approve-deny')).not.toBeNull()
    expect(button(html, 'approve-open')).toBeNull()
    expect(button(html, 'approve-allow')).not.toContain('disabled=""')
  })

  it('an edit of one file shows its path', () => {
    const { text, html } = render(waiting({ kind: 'file_edit', path: 'src/app.ts', diffPreview: '+x', multi: false }), { settled: true })
    expect(text).toContain('Edit src/app.ts')
    expect(button(html, 'approve-allow')).not.toBeNull()
  })

  it('does not answer before the rows have stood still', () => {
    // The list's own hook has not settled on the first render
    const { html } = render(waiting(command('ls')))
    expect(button(html, 'approve-allow')).toContain('disabled=""')
    expect(button(html, 'approve-deny')).toContain('disabled=""')
  })

  it('prints y and n on the row under the waiting list cursor only', () => {
    expect(render(waiting(command('ls')), { settled: true, keys: true }).text).toContain('y Allow n Deny')
    expect(render(waiting(command('ls')), { settled: true }).text).not.toContain('y Allow')
  })

  it('a card that offers more shows Open, still saying what it asks', () => {
    const agent: ApprovalDetail = { kind: 'agent_start', project: { id: 'p', name: 'site' }, tool: 'Codex', preset: 'safe', text: 'write the parser' }
    const a = render(waiting(agent), { settled: true })
    expect(a.text).toContain('Start agent Start Codex in site, with safe permissions, to write the parser?')
    expect(button(a.html, 'approve-open')).not.toBeNull()
    expect(button(a.html, 'approve-allow')).toBeNull()

    const files = render(waiting({ kind: 'file_edit', path: 'a.ts, b.ts', diffPreview: '', multi: true }), { settled: true })
    expect(button(files.html, 'approve-open')).not.toBeNull()
    expect(button(files.html, 'approve-allow')).toBeNull()
  })

  it('a question pending beside the approval shows Open', () => {
    const s = waiting(command('ls'), { pendingQuestions: [{ requestId: 'q', questions: [] }] })
    const { html } = render(s, { settled: true })
    expect(button(html, 'approve-open')).not.toBeNull()
    expect(button(html, 'approve-allow')).toBeNull()
  })

  it('draws nothing once nothing is pending', () => {
    expect(render(waiting(command('ls'), { pendingApproval: null })).html).toBe('')
  })
})

describe('what a row says', () => {
  it('cuts a command to its first line on the row and keeps it whole, with its folder, in the tooltip', () => {
    const d = command('git commit -m "one\n\ntwo"')
    expect(rowSummary(d)).toEqual({ verb: 'Run', line: 'git commit -m "one …' })
    expect(tooltipText(d)).toBe('git commit -m "one\n\ntwo"\n/work/site')
  })

  it("cuts a long diff in the tooltip and says the rest is on the card", () => {
    const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n')
    const t = tooltipText({ kind: 'file_edit', path: 'a.ts', diffPreview: diff, multi: false })
    expect(t.split('\n')).toHaveLength(25)
    expect(t).toContain('a.ts')
    expect(t).toMatch(/… 18 more lines on the card$/)
  })
})

describe('the waiting list keys and the settle key', () => {
  it('y and n answer only a row that offers Allow and Deny, by the id it shows', () => {
    expect(rowAnswerFor(waiting(command('ls')))).toEqual({ requestId: 'r7' })
    expect(rowAnswerFor(waiting({ kind: 'other', raw: '{}' }))).toBeNull()
    expect(rowAnswerFor(waiting(command('ls'), { state: 'working' }))).toBeNull()
    expect(rowAnswerFor(undefined)).toBeNull()
  })

  it('changes when an approval comes, goes or is replaced, or a session is added; not on a state change', () => {
    const a = waiting(command('ls'))
    const base = rowsKey({ s1: a })
    expect(rowsKey({ s1: { ...a, state: 'working' } as SessionSummary })).toBe(base)
    expect(rowsKey({ s1: { ...a, pendingApproval: null } })).not.toBe(base)
    expect(rowsKey({ s1: { ...a, pendingApproval: { requestId: 'r8', detail: command('ls') } } })).not.toBe(base)
    expect(rowsKey({ s1: a, s2: { ...a, id: 's2', pendingApproval: null } })).not.toBe(base)
  })
})
