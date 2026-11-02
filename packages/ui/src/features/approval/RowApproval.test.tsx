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

const { RowApproval, pathParts, rowsKey, rowView, tooltipText } = await import('./RowApproval.jsx')

// Only what the row reads from the platform: the key names its Kbd prints
const platform = { capabilities: { shortcutKeys: { mod: '⌘', alt: '⌥' } } } as unknown as Platform

beforeEach(() => {
  state = {}
})

const command = (c: string): Extract<ApprovalDetail, { kind: 'command' }> => ({ kind: 'command', command: c, cwd: '/work/site' })

function waiting(detail: ApprovalDetail, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    name: 'Clean up',
    state: 'waiting_approval',
    pendingApproval: { requestId: 'r7', detail },
    pendingQuestions: [],
    // The session's own folder, which an edit's path is shown relative to
    worktree: { path: '/work/site', branch: 'b' },
    ...over,
  } as SessionSummary
}

function render(session: SessionSummary | null, props: { settled?: boolean; keys?: boolean } = {}) {
  state = { sessions: session ? { [session.id]: session } : {}, approvalsInFlight: {} }
  const html = renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <RowApproval sessionId="s1" onOpen={() => {}} {...props} />
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
    // The waiting list's y and n press these, by these marks
    expect(button(html, 'approve-allow')).toContain('data-row-answer="allow"')
    expect(button(html, 'approve-deny')).toContain('data-row-answer="deny"')
  })

  it('does not answer until it has measured that the line fits whole, even once the rows have settled', () => {
    // The measurement is a layout effect, which a static render never runs: the buttons stay disabled
    const { html } = render(waiting(command('kill -TERM 40321')), { settled: true })
    expect(button(html, 'approve-allow')).toContain('disabled=""')
    expect(button(html, 'approve-deny')).toContain('disabled=""')
  })

  it("an edit shows the file's name first, then its folder inside the session's folder", () => {
    const { text, html } = render(waiting({ kind: 'file_edit', path: '/work/site/src/features/app.ts', diffPreview: '+x', multi: false }), { settled: true })
    expect(text).toContain('Edit app.ts src/features/')
    expect(html).toMatch(/data-testid="inbox-approval-file-s1"[^>]*>app\.ts</)
    expect(button(html, 'approve-allow')).not.toBeNull()
  })

  // #683 review: requests that say nothing on their line, or carry a risk it does not show, open the session
  it('an empty, flagged, multi-line or outside-the-folder request shows Open', () => {
    const open = (d: ApprovalDetail) => {
      const { html, text } = render(waiting(d), { settled: true })
      expect(button(html, 'approve-allow'), JSON.stringify(d)).toBeNull()
      expect(button(html, 'approve-open'), JSON.stringify(d)).not.toBeNull()
      return text
    }
    // A Codex network approval with no command says what it asks, not `Run ` and nothing
    expect(open({ kind: 'command', command: '', cwd: '/w', network: { host: 'docs.example.com', protocol: 'https' } })).toContain('Run network access to docs.example.com')
    open({ ...command('curl x'), unsandboxed: true })
    expect(open({ ...command('y'), stdin: true })).toContain('Type y')
    open(command('cd /tmp\nrm -rf build'))
    open({ kind: 'file_edit', path: '(no path)', diffPreview: '', multi: false })
    expect(open({ kind: 'file_edit', path: '/work/site/old.ts', diffPreview: '', multi: false, change: 'delete' })).toContain('Delete old.ts')
    open({ kind: 'file_edit', path: '/work/site/a.ts', diffPreview: '', multi: false, change: 'move', movePath: '/work/site/b.ts' })
    open({ kind: 'file_edit', path: '/etc/hosts', diffPreview: '', multi: false })
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
    expect(a.text).toContain('Start agent Start Codex in &quot;site&quot;, with safe permissions, to write the parser?')
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
  it('cuts a command to its first line on the row, does not answer it there, and keeps it whole in the tooltip', () => {
    const d = command('git commit -m "one\n\ntwo"')
    expect(rowView(d, null)).toMatchObject({ verb: 'Run', line: 'git commit -m "one …', inPlace: false })
    expect(tooltipText(d)).toBe('git commit -m "one\n\ntwo"\n/work/site')
  })

  it('the tooltip carries what the request says beyond its line', () => {
    expect(tooltipText({ kind: 'command', command: '', cwd: '/w', network: { host: 'h.example', protocol: 'https' }, reason: 'fetch' })).toBe(
      '/w\nNetwork access to h.example (https)\nReason: fetch',
    )
    expect(tooltipText({ kind: 'file_edit', path: '/w/a.ts', diffPreview: '-a', multi: false, change: 'delete' })).toBe('/w/a.ts\nDeletes the file\n\n-a')
  })

  it("splits a path into its name and its folder inside the session's folder, on any platform", () => {
    expect(pathParts('/work/site/src/a.ts', '/work/site')).toEqual({ name: 'a.ts', dir: 'src/', inside: true })
    expect(pathParts('/work/site/a.ts', '/work/site/')).toEqual({ name: 'a.ts', dir: '', inside: true })
    expect(pathParts('src/a.ts', '/work/site')).toEqual({ name: 'a.ts', dir: 'src/', inside: true })
    expect(pathParts('C:\\Work\\Site\\src\\a.ts', 'c:\\work\\site')).toEqual({ name: 'a.ts', dir: 'src/', inside: true })
    // Outside, or nothing to compare with: the whole folder, and not inside
    expect(pathParts('/work/site-2/a.ts', '/work/site')).toEqual({ name: 'a.ts', dir: '/work/site-2/', inside: false })
    expect(pathParts('../x/a.ts', '/work/site').inside).toBe(false)
    expect(pathParts('/etc/hosts', null)).toEqual({ name: 'hosts', dir: '/etc/', inside: false })
  })

  // #683 re-review: only the front of an absolute path was compared, so this was "inside" and showed "Edit zshrc src/…"
  it('normalizes a path before comparing it, so one that climbs out of the folder is outside', () => {
    expect(pathParts('/Users/me/proj/src/../../../../etc/zshrc', '/Users/me/proj')).toEqual({ name: 'zshrc', dir: '/etc/', inside: false })
    expect(pathParts('/Users/me/proj/src/./a/../b.ts', '/Users/me/proj')).toEqual({ name: 'b.ts', dir: 'src/', inside: true })
    expect(pathParts('/Users/me/proj//src///b.ts', '/Users/me/proj/')).toEqual({ name: 'b.ts', dir: 'src/', inside: true })
    expect(pathParts('/Users/me/proj/../proj-2/a.ts', '/Users/me/proj')).toEqual({ name: 'a.ts', dir: '/Users/me/proj-2/', inside: false })
    // The folder itself, or its parent through a dot segment, is not a file inside it
    expect(pathParts('/Users/me/proj/src/..', '/Users/me/proj').inside).toBe(false)
    // A root given with dot segments is read the same way
    expect(pathParts('/Users/me/proj/a.ts', '/Users/me/x/../proj').inside).toBe(true)
    // Relative: a .. that stays inside is fine, one that climbs out is not
    expect(pathParts('src/../a.ts', '/Users/me/proj')).toEqual({ name: 'a.ts', dir: '', inside: true })
    expect(pathParts('src/../../a.ts', '/Users/me/proj')).toEqual({ name: 'a.ts', dir: '../', inside: false })
  })

  it('normalizes Windows paths the same way, without case', () => {
    expect(pathParts('C:\\proj\\..\\x', 'C:\\proj')).toEqual({ name: 'x', dir: 'C:/', inside: false })
    expect(pathParts('C:\\proj\\src\\..\\..\\Windows\\win.ini', 'c:\\Proj')).toEqual({ name: 'win.ini', dir: 'C:/Windows/', inside: false })
    expect(pathParts('c:/PROJ/src/./a.ts', 'C:\\proj')).toEqual({ name: 'a.ts', dir: 'src/', inside: true })
    // Another drive is outside
    expect(pathParts('D:\\proj\\a.ts', 'C:\\proj').inside).toBe(false)
  })

  it("cuts a long diff in the tooltip and says the rest is on the card", () => {
    const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n')
    const t = tooltipText({ kind: 'file_edit', path: 'a.ts', diffPreview: diff, multi: false })
    expect(t.split('\n')).toHaveLength(25)
    expect(t).toContain('a.ts')
    expect(t).toMatch(/… 18 more lines on the card$/)
  })
})

describe('the settle key', () => {
  it('changes when an approval comes, goes or is replaced, or a session is added; not on a state change', () => {
    const a = waiting(command('ls'))
    const base = rowsKey({ s1: a })
    expect(rowsKey({ s1: { ...a, state: 'working' } as SessionSummary })).toBe(base)
    expect(rowsKey({ s1: { ...a, pendingApproval: null } })).not.toBe(base)
    expect(rowsKey({ s1: { ...a, pendingApproval: { requestId: 'r8', detail: command('ls') } } })).not.toBe(base)
    expect(rowsKey({ s1: a, s2: { ...a, id: 's2', pendingApproval: null } })).not.toBe(base)
  })
})
