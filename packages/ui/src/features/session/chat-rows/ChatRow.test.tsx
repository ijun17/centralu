import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@cc/core'
import type { ProjectInfo, StoredMessage } from '@cc/protocol'
import type { AppState, ChatItem } from '../../../store/store.js'

/*
 * Each row kind drawn from a fixture, pinning what the conversation shows today (#428): the move out of
 * SessionView.tsx changed no DOM, and a later change to a card shows up here before it shows up on screen.
 *
 * The rows are drawn with renderToStaticMarkup, which reads a zustand store's *initial* state (the server
 * snapshot of useSyncExternalStore), so `useStore` is replaced by one that reads `state`: a test seeds the
 * sessions, projects and subagent steps its row looks up.
 */
let state: Partial<AppState> = {}
vi.mock('../../../store/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../store/store.js')>()
  const useStore = (selector: (s: AppState) => unknown) => selector({ ...real.useStore.getState(), ...state })
  return { ...real, useStore: Object.assign(useStore, real.useStore) }
})

const { ChatRow } = await import('./ChatRow.jsx')
const { AttachmentStrip } = await import('./attachments.jsx')
const { AskedByBadge } = await import('./delegation.jsx')

beforeEach(() => {
  state = {}
})

const session = (id: string, over: Partial<SessionSummary> = {}) =>
  ({ id, projectId: 'p1', name: `Session ${id}`, state: 'idle', ...over }) as SessionSummary
const project = (id: string, name: string) => ({ id, name }) as ProjectInfo
const tool = (over: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', seq: 1, tool: 'Bash', title: 'ls -la', ...over })
const stored = (seq: number, kind: StoredMessage['kind'], payload: unknown, role: StoredMessage['role'] = 'assistant'): StoredMessage =>
  ({ sessionId: 'sub', seq, role, kind, payload, ts: 0 })

const render = (node: React.ReactNode) => {
  const html = renderToStaticMarkup(node)
  // Text alone, so assertions read as what a person sees
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return { html, text: text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') }
}
const row = (item: ChatItem, over: { nested?: boolean; leaving?: boolean } = {}) =>
  render(<ChatRow item={item} projectRoot="/repo" projectId="p1" sessionId="s1" {...over} />)
const testIds = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])

describe('ChatRow: what the person sent', () => {
  it('draws a plain message as a solid bubble with no source line', () => {
    const { html, text } = row({ kind: 'user', seq: 1, text: 'Hello there' })
    expect(testIds(html)).toEqual(['msg-user'])
    expect(text).toBe('Hello there')
    expect(html).toContain('border-ink-faint/40')
    expect(html).not.toContain('border-dashed')
  })

  it('names the session a delegated message came from and switches the bubble to dashed', () => {
    const { html, text } = row({ kind: 'user', seq: 1, text: 'Do the task', from: { sessionId: 'o1', name: 'Manager' } })
    expect(testIds(html)).toEqual(['msg-user', 'msg-user-from'])
    expect(text).toBe('Manager ⤷ Do the task')
    expect(html).toContain('border-dashed border-ink-muted/50')
  })

  it('names the app that wrote a message', () => {
    const { html, text } = row({ kind: 'user', seq: 1, text: 'Open #12', fromApp: { appId: 'board', projectId: 'p1', name: 'Board' } })
    expect(testIds(html)).toEqual(['msg-user', 'msg-user-from-app'])
    expect(text).toBe('Board app ⤷ Open #12')
  })

  it('draws an image with bytes as a thumbnail, a file and a byteless image as chips', () => {
    const { html, text } = row({
      kind: 'user',
      seq: 1,
      text: 'See these',
      attachments: [
        { kind: 'image', path: '/tmp/shot.png', name: 'shot.png', mime: 'image/png', data: 'AAAA' },
        { kind: 'file', path: 'notes.txt', name: 'notes.txt' },
        { kind: 'image', path: '/tmp/gone.png', name: 'gone.png', mime: 'image/png' },
      ],
    })
    expect(testIds(html)).toEqual(['msg-user', 'msg-user-attachment', 'msg-user-attachment', 'msg-user-attachment'])
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(text).toBe('DOC notes.txt IMG gone.png See these')
  })

  it('draws no empty bubble for a message that only sent an image', () => {
    const { html } = row({ kind: 'user', seq: 1, text: '', attachments: [{ kind: 'image', path: '/tmp/a.png', name: 'a.png', mime: 'image/png', data: 'AAAA' }] })
    expect(html).not.toContain('bg-surface-hover')
  })
})

describe('ChatRow: what the agent said', () => {
  it('renders a reply as markdown', () => {
    const { html, text } = row({ kind: 'assistant', seq: 2, text: 'Done with **all** of it' })
    expect(testIds(html)[0]).toBe('msg-assistant')
    expect(html).toContain('<strong>all</strong>')
    expect(text).toBe('Done with all of it')
  })

  it('renders a reasoning summary dimmed, through markdown too', () => {
    const { html, text } = row({ kind: 'reasoning', seq: 2, text: '**Planning** the change' })
    expect(testIds(html)[0]).toBe('msg-reasoning')
    expect(html).toContain('text-ink-muted [&amp;_strong]:text-ink-muted')
    expect(text).toBe('Planning the change')
  })

  it('shows an image the agent produced, and says why when it cannot', () => {
    const shown = row({ kind: 'image', seq: 3, mime: 'image/png', data: 'AAAA', path: '/tmp/out.png' })
    expect(testIds(shown.html)).toEqual(['msg-image'])
    expect(shown.html).toContain('src="data:image/png;base64,AAAA"')
    expect(shown.html).toContain('alt="/tmp/out.png"')

    const missing = row({ kind: 'image', seq: 3, mime: 'image/png', data: '', path: '/tmp/out.png', note: 'over the 500MB cap' })
    expect(testIds(missing.html)).toEqual(['msg-image-missing'])
    expect(missing.text).toBe('The image could not be displayed — over the 500MB cap /tmp/out.png')
  })
})

describe('ChatRow: approvals and marks', () => {
  it('draws nothing for an approval still pending, and the decision once made', () => {
    expect(row({ kind: 'approval', seq: 4, requestId: 'r1', summary: 'rm -rf build' }).html).toBe('')
    const denied = row({ kind: 'approval', seq: 4, requestId: 'r1', summary: 'rm -rf build', decision: 'deny' })
    expect(testIds(denied.html)).toEqual(['msg-approval-log'])
    expect(denied.text).toBe('Denied · rm -rf build')
    expect(row({ kind: 'approval', seq: 4, requestId: 'r1', summary: 'git push', decision: 'allow' }).text).toBe('Allowed · git push')
  })

  it('draws a divider label, and a notice through NoticeMark', () => {
    const divider = row({ kind: 'mark', seq: 5, text: 'conversation compacted here' })
    expect(testIds(divider.html)).toEqual(['msg-mark'])
    expect(divider.text).toBe('conversation compacted here')

    const notice = row({ kind: 'mark', seq: 5, text: 'ignored', notice: { head: 'Codex · config warning', audience: 'you', body: 'the key is unknown', from: 'Codex' } })
    expect(testIds(notice.html)).toEqual(['msg-mark', 'notice-head', 'notice-audience', 'notice-summary'])
    expect(notice.text).not.toContain('ignored')
    expect(notice.text).toContain('Codex · config warning')
  })
})

describe('ChatRow: tool cards', () => {
  it('shows the tool and its title in the header, collapsed, with three lines of output and the rest counted', () => {
    const { html, text } = row(tool({ result: 'one\ntwo\nthree\nfour\nfive\n\n' }))
    expect(testIds(html)).toEqual(['tool-card', 'tool-card-toggle', 'tool-card-output', 'tool-card-more'])
    expect(html).toContain('aria-expanded="false"')
    expect(text).toBe('Bash ls -la one two three 2 more lines')
    expect(html).toContain('max-h-[3lh] overflow-hidden')
  })

  it('shows a short result whole, with nothing to expand', () => {
    const { html, text } = row(tool({ result: 'ok' }))
    expect(testIds(html)).toEqual(['tool-card', 'tool-card-toggle', 'tool-card-output'])
    expect(text).toBe('Bash ls -la ok')
  })

  it('keeps a failure visible in the header while collapsed', () => {
    const { text } = row(tool({ result: 'No such file', ok: false }))
    expect(text).toBe('Bash ls -la Failed No such file')
  })

  it('shows the tail of live output while the tool still runs, and drops it once the result is in', () => {
    const running = row(tool({ live: 'a\nb\nc\nd\n' }))
    expect(testIds(running.html)).toEqual(['tool-card', 'tool-card-toggle', 'tool-card-live'])
    expect(running.text).toBe('Bash ls -la b c d')
    const finished = row(tool({ live: 'a\nb\nc\nd\n', result: 'done' }))
    expect(testIds(finished.html)).toEqual(['tool-card', 'tool-card-toggle', 'tool-card-output'])
  })

  it('draws a running card with no output as the header alone', () => {
    const { html, text } = row(tool())
    expect(testIds(html)).toEqual(['tool-card', 'tool-card-toggle'])
    expect(text).toBe('Bash ls -la')
  })

  it('draws the file a call names as a link in the title, apart from the toggle (a button holds no button)', () => {
    const { html, text } = row(tool({ tool: 'Read', title: 'Read: /repo/src/a.ts', paths: ['/repo/src/a.ts'] }))
    expect(testIds(html)).toEqual(['tool-card', 'tool-card-toggle', 'tool-card-title', 'file-link'])
    expect(text).toBe('Read Read: /repo/src/a.ts')
    // The link's text is the path, and it is not inside the toggle button
    expect(html).toMatch(/<button[^>]*data-testid="file-link"[^>]*>\/repo\/src\/a\.ts<\/button>/)
    expect(html).not.toMatch(/data-testid="tool-card-toggle"[^>]*>(?:(?!<\/button>).)*file-link/s)
  })

  it('keeps a title whose file is outside the project, or that names none, as one toggle button', () => {
    const outside = row(tool({ tool: 'Read', title: 'Read: /etc/hosts.conf', paths: ['/etc/hosts.conf'] }))
    expect(testIds(outside.html)).toEqual(['tool-card', 'tool-card-toggle'])
    expect(outside.text).toBe('Read Read: /etc/hosts.conf')
    expect(testIds(row(tool({ tool: 'Read', title: 'Read: /repo/src/a.ts' })).html)).toEqual(['tool-card', 'tool-card-toggle'])
  })

  it('puts a closed steps drawer under a card that launched a subagent, and under no other', () => {
    const launch = row(tool({ tool: 'Agent', title: 'Explore the repo', callId: 'c1' }))
    expect(testIds(launch.html)).toEqual(['tool-card', 'tool-card-toggle', 'subagent-steps', 'subagent-steps-toggle'])
    expect(launch.text).toBe("Agent Explore the repo Subagent's steps")
    expect(testIds(row(tool({ callId: 'c1' })).html)).not.toContain('subagent-steps')
  })

  it('draws the open drawer with the subagent steps as conversation rows, nested', () => {
    state = {
      subagentSteps: {
        s1: {
          c1: {
            open: true,
            more: true,
            loading: false,
            error: null,
            rows: [
              stored(1, 'text', { text: 'Looking' }),
              stored(2, 'tool_call', { callId: 'sub-1', summary: { tool: 'Read', title: 'README.md' } }),
              stored(3, 'tool_result', { callId: 'sub-1', summary: '# Title', ok: true }),
            ],
          },
        },
      },
    }
    const { html, text } = row(tool({ tool: 'Task', title: 'Explore', callId: 'c1' }))
    expect(testIds(html)).toEqual([
      'tool-card', 'tool-card-toggle', 'subagent-steps', 'subagent-steps-toggle', 'subagent-steps-list',
      'msg-assistant', 'markdown', 'tool-card', 'tool-card-toggle', 'tool-card-output', 'subagent-steps-more',
    ])
    expect(text).toBe("Task Explore Subagent's steps Looking Read README.md # Title Show more steps")
  })

  it('says when a subagent left no steps, and when they could not be read', () => {
    state = { subagentSteps: { s1: { c1: { open: true, more: false, loading: false, error: null, rows: [] } } } }
    const empty = row(tool({ tool: 'Agent', title: 'x', callId: 'c1' }))
    expect(testIds(empty.html)).toContain('subagent-steps-empty')
    expect(empty.text).toContain('No steps were recorded for this agent.')

    state = { subagentSteps: { s1: { c1: { open: true, more: false, loading: false, error: 'host went away', rows: [] } } } }
    const failed = row(tool({ tool: 'Agent', title: 'x', callId: 'c1' }))
    expect(testIds(failed.html)).toContain('subagent-steps-error')
    expect(failed.text).toContain('Could not load the steps — host went away Try again')
    expect(testIds(failed.html)).not.toContain('subagent-steps-empty')
  })
})

describe('ChatRow: rows that point elsewhere', () => {
  it('draws a worktree proposal as a line naming the branch', () => {
    const { html, text } = row(tool({ tool: 'mcp__centralu__propose_worktree_session', title: 'feat/rows' }))
    expect(testIds(html)).toEqual(['worktree-proposal'])
    expect(text).toBe('↖ Branch feat/rows proposed — the + button on this project opens the prefilled dialog')
  })

  it('says a worktree session was proposed when the title is only the tool name', () => {
    const { text } = row(tool({ tool: 'propose_worktree_session', title: 'propose_worktree_session' }))
    expect(text).toBe('↖ A worktree session was proposed — the + button on this project opens the prefilled dialog')
  })

  it('draws an ask_project call still running with no way in yet', () => {
    const { html, text } = row(tool({ tool: 'mcp__centralu__ask_project', title: 'Docs' }))
    expect(testIds(html)).toEqual(['ask-project-card', 'ask-project-toggle', 'ask-project-status'])
    expect(text).toBe('↗ Asked Docs · working…')
  })

  it('links the session doing the work once the answer names it, and keeps the answer behind the toggle', () => {
    state = { sessions: { d1: session('d1', { projectId: 'p2', name: 'Docs worker' }) } }
    const { html, text } = row(tool({ tool: 'ask_project', title: 'Docs', result: 'Answer from [d1] in Docs: it is on page 3', ok: true }))
    expect(testIds(html)).toEqual(['ask-project-card', 'ask-project-toggle', 'ask-project-status', 'ask-project-open'])
    expect(text).toBe('↗ Asked Docs · answered Open session →')
    expect(html).toContain('title="Docs worker"')
  })

  it('tells a refusal, a session still working and the other project state apart', () => {
    expect(row(tool({ tool: 'ask_project', title: 'ask_project', result: 'No such project', ok: false })).text).toBe('↗ Asked another project · did not finish')
    state = { sessions: { d1: session('d1', { projectId: 'p2' }) } }
    // The host's wording (orchestrator-tools.ts): the session's name and id, then the project
    const pending = 'Docs is still working on it in the session "Docs worker" [d1] in Docs. Ask again later.'
    expect(row(tool({ tool: 'ask_project', title: 'Docs', result: pending })).text).toBe(
      '↗ Asked Docs · still working Open session →',
    )
    state = {
      projects: { p2: project('p2', 'Docs') },
      sessions: { d1: session('d1', { projectId: 'p2', state: 'waiting_approval' }) },
      chat: { d1: [{ kind: 'user', seq: 1, text: "A task sent through Centralu's ask_project", from: { sessionId: 's1', name: 'Me' } }] },
    }
    expect(row(tool({ tool: 'ask_project', title: 'Docs' })).text).toBe('↗ Asked Docs · waiting for approval there Open session →')
  })
})

describe('AskedByBadge', () => {
  it('says the caller is gone rather than disappearing', () => {
    const { html, text } = render(<AskedByBadge callerId="gone" projectId="p1" />)
    expect(testIds(html)).toEqual(['asked-by-badge'])
    expect(text).toBe('Asked by a session no longer here')
    expect(html).not.toContain('<button')
  })

  it('names the session when it is of the same project, and the project otherwise', () => {
    state = { projects: { p2: project('p2', 'Docs') }, sessions: { c1: session('c1', { projectId: 'p1' }), c2: session('c2', { projectId: 'p2' }) } }
    expect(render(<AskedByBadge callerId="c1" projectId="p1" />).text).toBe('↩ Started by Session c1')
    expect(render(<AskedByBadge callerId="c2" projectId="p1" />).text).toBe('↩ Asked by Docs')
    expect(render(<AskedByBadge callerId="c2" projectId="p1" />).html).toContain('title="Go back to Session c2"')
  })
})

describe('AttachmentStrip', () => {
  const strip = (attachments: Parameters<typeof AttachmentStrip>[0]['attachments'], uploading = 0) =>
    render(<AttachmentStrip attachments={attachments} uploading={uploading} onRemove={() => {}} />)

  it('counts what is still being attached', () => {
    expect(strip([], 1).text).toBe('Attaching a file…')
    expect(strip([], 3).text).toBe('Attaching 3 files…')
    expect(testIds(strip([], 1).html)).toEqual(['attachment-list', 'attachment-uploading'])
  })

  it('draws a file as a chip and an image as a thumbnail, each with its remove button', () => {
    const { html, text } = strip([
      { kind: 'file', path: 'notes.txt', name: 'notes.txt' },
      { kind: 'image', path: '/tmp/shot.png', name: 'shot.png', mime: 'image/png', data: 'AAAA' },
    ])
    expect(testIds(html)).toEqual(['attachment-list', 'attachment-item', 'attachment-chip', 'attachment-item', 'attachment-thumb'])
    expect(text).toBe('DOC notes.txt')
    expect(html).toContain('aria-label="Remove attachment notes.txt"')
    expect(html).toContain('aria-label="Remove attachment shot.png"')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
  })
})

describe("ChatRow: Centralu's own tool calls (#730)", () => {
  it('draws a start_agent call with the Centralu mark, what it did and its job, and opens the child it names', () => {
    state = { sessions: { c1: session('c1', { name: 'Parser' }) } }
    const { html, text } = row(
      tool({
        tool: 'mcp__centralu__start_agent',
        title: 'write the parser (codex, heavy)',
        centralu: { tool: 'start_agent', label: 'Started an agent' },
        result: 'the codex session "Parser" [c1] answered, as JSON: "done"',
        ok: true,
      }),
    )
    expect(html).toContain('data-centralu-call="centralu"')
    expect(html).toContain('data-mark="centralu"')
    expect(html).toContain('border-l-line-strong')
    expect(testIds(html)).toEqual(['tool-card', 'tool-card-toggle', 'centralu-call-mark', 'centralu-call-label', 'tool-card-title', 'centralu-call-open', 'tool-card-output'])
    expect(text).toMatch(/^Started an agent write the parser \(codex, heavy\) Open session →/)
    expect(text).not.toContain('mcp__centralu__start_agent')
    expect(html).toContain('title="Parser"')
  })

  it('reads a Claude name an older host stored without the mark, and gives no link to the session it is in', () => {
    const { html, text } = row(tool({ tool: 'mcp__centralu__read_session', title: 'mcp__centralu__read_session', centralu: undefined }))
    expect(html).toContain('data-centralu-call="centralu"')
    expect(text).toBe('Read session')
    state = { sessions: { s1: session('s1') } }
    const self = row(tool({ tool: 'mcp__centralu__agent_session', title: 'Checked on an agent', centralu: { tool: 'agent_session', label: 'Checked on an agent', sessionId: 's1' } }))
    expect(self.text).toBe('Checked on an agent')
    expect(testIds(self.html)).not.toContain('centralu-call-open')
  })

  it("draws an app's tool with the app's window icon and name, and Codex's title without the server and tool", () => {
    state = { externalApps: [{ appId: 'board', name: 'Project board' }] as AppState['externalApps'] }
    const { html, text } = row(tool({ tool: 'list_items', title: 'app-board: list_items {"status":"Ready"}', centralu: { tool: 'list_items', app: 'board' } }))
    expect(html).toContain('data-centralu-call="app"')
    expect(html).toContain('data-mark="app"')
    expect(text).toBe('Project board: list items {"status":"Ready"}')
  })

  it('leaves an ordinary MCP call and a built-in tool as they were', () => {
    for (const item of [tool({ tool: 'mcp__playwright__browser_click', title: 'mcp__playwright__browser_click' }), tool({ tool: 'Bash', title: 'ls' })]) {
      const { html } = row(item)
      expect(html).not.toContain('data-centralu-call')
      expect(testIds(html)).not.toContain('centralu-call-mark')
      expect(html).not.toContain('border-l-line-strong')
    }
  })
})
