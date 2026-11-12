import { describe, expect, it } from 'vitest'
import { centraluCallOf, mcpNameParts, toolCallLine, type ToolSummary } from '@cc/protocol'
import { toolSummary } from './claude/normalize.js'
import { normalizeNotification } from './codex/normalize.js'
import { keepAttachedAppMarks } from './tool-titles.js'

/**
 * Centralu's own tool calls, marked by the adapter that knows the server (#730). Claude names the server in the tool
 * name, Codex apart from it: the screen could only have told Codex's from another server's tool of the same name by
 * reading the title. Both adapters mark them the same way, with what the call did in words and the argument a person
 * follows it by.
 */
const codex = (server: string, tool: string, args: unknown): ToolSummary =>
  (normalizeNotification('s', { method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'm', server, tool, status: 'inProgress', arguments: args } } })[0] as { summary: ToolSummary }).summary

describe.each([
  ['claude', (server: string, tool: string, args: Record<string, unknown>) => toolSummary(`mcp__${server}__${tool}`, args)],
  ['codex', codex],
] as const)('%s marks a call to Centralu\'s own servers (#730)', (_name, summary) => {
  it('start_agent: what it did, and the job with the tool and model asked for', () => {
    const s = summary('centralu', 'start_agent', { task: 'write the parser\nthen test it', tool: 'codex', difficulty: 'heavy' })
    expect(s.centralu).toEqual({ tool: 'start_agent', label: 'Started an agent' })
    expect(s.title).toBe('write the parser … (codex, heavy)')
  })

  it('agent_session: the action in words, the session it names apart', () => {
    const s = summary('centralu', 'agent_session', { sessionId: 'c1', action: 'delete' })
    expect(s.centralu).toEqual({ tool: 'agent_session', label: 'Deleted an agent', sessionId: 'c1' })
    expect(s.title).toBe('Deleted an agent')
    expect(summary('centralu', 'agent_session', { sessionId: 'c1', action: 'send', text: 'also this' }).title).toBe('also this')
  })

  // #1948: more work for a session is a mail send, so a send keeps the words and the chip an agent_session send had
  it('mail send: "Sent mail", the subject or the first line, and the session it names by id apart', () => {
    const child = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const s = summary('centralu', 'mail', { action: 'send', to: child, text: 'and the linter\nthen push' })
    expect(s.centralu).toEqual({ tool: 'mail', label: 'Sent mail', sessionId: child })
    expect(s.title).toBe('and the linter …')
    expect(summary('centralu', 'mail', { action: 'send', to: `mac.${child}`, subject: 'Lint', text: 'x' })).toMatchObject({ title: 'Lint', centralu: { sessionId: `mac.${child}` } })
    for (const to of ['person', 'parent', 'reviewer'])
      expect(summary('centralu', 'mail', { action: 'send', to, text: 'done?' })).toMatchObject({ title: 'done?', centralu: { tool: 'mail', label: 'Sent mail' } })
    expect(summary('centralu', 'mail', { action: 'send', to: 'parent', text: 'done?' }).centralu?.sessionId).toBeUndefined()
  })

  it('mail reply says "Replied" with no chip; the other mail actions keep the card they had, as an old agent_session send does', () => {
    expect(summary('centralu', 'mail', { action: 'reply', thread: 't1', text: 'yes' })).toMatchObject({ title: 'yes', centralu: { tool: 'mail', label: 'Replied' } })
    expect(summary('centralu', 'mail', { action: 'reply', thread: 't1', text: 'yes' }).centralu?.sessionId).toBeUndefined()
    expect(summary('centralu', 'mail', { action: 'inbox' }).centralu).toEqual({ tool: 'mail' })
    expect(summary('centralu', 'agent_session', { sessionId: 'c1', action: 'send', text: 'also this' }).centralu).toEqual({ tool: 'agent_session', label: 'Sent more to an agent', sessionId: 'c1' })
  })

  it("an app's tool names the app; another server's tool of a Centralu name is not marked", () => {
    expect(summary('app-board', 'list_items', {}).centralu).toEqual({ tool: 'list_items', app: 'board' })
    const other = summary('other', 'start_agent', { task: 'x' })
    expect(other.centralu).toBeUndefined()
    expect(other.title).not.toBe('x')
  })
})

describe('reading a mark (#730)', () => {
  it("reads an older host's Claude name with no mark, and nothing else", () => {
    expect(centraluCallOf({ tool: 'mcp__centralu__read_session' })).toEqual({ tool: 'read_session' })
    expect(centraluCallOf({ tool: 'mcp__app-board__list_items' })).toEqual({ tool: 'list_items', app: 'board' })
    expect(centraluCallOf({ tool: 'mcp__claude_ai_Notion__notion-search' })).toBeNull()
    expect(centraluCallOf({ tool: 'start_agent' })).toBeNull()
    expect(mcpNameParts('mcp__claude_ai_Notion__notion-search')).toEqual({ server: 'claude_ai_Notion', tool: 'notion-search' })
  })

  it("a session's preview says what a Centralu call did; an ordinary call's stays its title", () => {
    expect(toolCallLine(toolSummary('mcp__centralu__start_agent', { task: 'write the parser' }))).toBe('Started an agent: write the parser')
    expect(toolCallLine(toolSummary('mcp__centralu__agent_session', { sessionId: 'c1', action: 'list' }))).toBe('Listed its agents')
    expect(toolCallLine(toolSummary('Bash', { command: 'ls' }))).toBe('ls')
  })
})

describe('review follow-ups (#730)', () => {
  it("a blank project leaves ask_project's title to its row, which says \"another project\"", () => {
    expect(toolSummary('mcp__centralu__ask_project', { project: '  ' }).title).toBe('mcp__centralu__ask_project')
    expect(codex('centralu', 'ask_project', { project: '' }).title).toBe('ask_project')
  })

  it("keeps an app's mark only for an app attached to the session; a repository's own app-<x> server is ordinary", () => {
    const call = { type: 'tool_call' as const, sessionId: 's', callId: 'c', summary: toolSummary('mcp__app-notes__add', { text: 'x' }) }
    expect(keepAttachedAppMarks(call, () => ['app-notes'])).toBe(call)
    const stray = keepAttachedAppMarks(call, () => ['app-board'])
    expect(stray.type === 'tool_call' && stray.summary).toEqual({ tool: 'mcp__app-notes__add', title: 'mcp__app-notes__add', paths: [] })
    const step = { type: 'subagent_event' as const, sessionId: 's', parentCallId: 'p', step: call }
    const strayStep = keepAttachedAppMarks(step, () => [])
    expect(strayStep.type === 'subagent_event' && strayStep.step.type === 'tool_call' && strayStep.step.summary.centralu).toBeUndefined()
    // Centralu's own server is never stripped
    const own = { ...call, summary: toolSummary('mcp__centralu__start_agent', { task: 'x' }) }
    expect(keepAttachedAppMarks(own, () => [])).toBe(own)
  })
})
