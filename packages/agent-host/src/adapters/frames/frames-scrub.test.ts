import { describe, expect, it } from 'vitest'
import { scrub } from '../../../../../scripts/frames-scrub.mjs'

/**
 * What the scrub does to Claude Code's stream-json (#1498): the recordings it makes are committed, and carry the person's
 * account, connectors and folders in frames nobody wrote by hand. `recordings-private.test.ts` checks the files; this checks
 * the rules that make them, on lines made for it.
 */

const CWD = 'C:\\Users\\alice\\AppData\\Local\\Temp\\run-1'
const HOME = 'C:\\Users\\alice'
const MARK = 'ce47a1ce47a1'

const line = (dir: 'in' | 'out', msg: unknown) => ({ t: 1, dir, line: JSON.stringify(msg) })
const run = (frames: ReturnType<typeof line>[]) => scrub(frames, CWD, HOME, { tmp: 'C:\\Users\\alice\\AppData\\Local\\Temp', user: 'alice' }) as { dir: string; msg: Record<string, unknown> }[]

describe('scrubbing Claude Code’s frames', () => {
  it('keeps an id a UUID, numbers it the same wherever it is named, and keeps Centralu’s mark on its own inputs', () => {
    const input = '5f87ace6-4f22-4f28-a061-ce47a1ce47a1'
    const session = '988fabc8-f6d7-4ba3-950a-7db6e6ab3792'
    const [sent, echoed, init] = run([
      line('out', { type: 'user', uuid: input, session_id: '', message: { role: 'user', content: [] } }),
      line('in', { type: 'command_lifecycle', command_uuid: input, state: 'queued', uuid: '2e1d1c3e-bba8-4446-8549-629a93bbdf3d', session_id: session }),
      line('in', { type: 'system', subtype: 'status', session_id: session, user_message_uuids: [input], uuid: 'c7910e62-a42a-42a3-a9c1-142652be3a5e' }),
    ]).map((f) => f.msg)
    expect(sent!.uuid).toBe(`00000001-0000-4000-8000-${MARK}`)
    expect(echoed!.command_uuid).toBe(sent!.uuid)
    expect(init!.user_message_uuids).toEqual([sent!.uuid])
    expect(echoed!.session_id).toBe(init!.session_id)
    expect(String(echoed!.session_id)).toMatch(/^0{7}\d-0000-4000-8000-0{11}\d$/)
    expect(JSON.stringify([sent, echoed, init])).not.toContain(session)
  })

  it('says nothing of the person’s account, plugins, connectors, commands or folders', () => {
    const [init, answer] = run([
      line('in', {
        type: 'system',
        subtype: 'init',
        cwd: CWD,
        tools: ['Bash', 'mcp__claude_ai_Notion__search', 'mcp__centralu__recall'],
        mcp_servers: [{ name: 'claude.ai Notion', status: 'connected' }],
        slash_commands: ['compact', 'my-secret-skill'],
        plugins: [{ name: 'acme', path: `${HOME}\\.claude\\plugins\\acme`, source: 'acme@market' }, { name: 'cc-plugin-agents-md', path: 'builtin', source: 'x' }],
        agents: ['Explore', 'my-agent'],
        memory_paths: { auto: `${HOME}\\.claude\\projects\\C--Users-alice-AppData-Local-Temp-run-1` },
      }),
      line('in', {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'abc123',
          response: {
            commands: [{ name: 'compact', description: 'x', builtin: true }, { name: 'my-secret-skill', description: 'private words', builtin: false }],
            account: { email: 'alice@example.com', organization: 'Alice Org', subscriptionType: 'Max', apiProvider: 'firstParty' },
          },
        },
      }),
    ]).map((f) => f.msg)
    expect(init).toMatchObject({
      cwd: '<cwd>',
      tools: ['Bash', 'mcp__centralu__recall'],
      mcp_servers: [{ name: 'server-1', status: 'connected' }],
      slash_commands: ['compact', 'command-1'],
      plugins: [{ name: 'plugin-1', path: '<plugin>' }, { path: 'builtin' }],
      agents: ['Explore', 'agent-1'],
    })
    const response = (answer!.response as { response: { commands: { name: string; description: string }[]; account: object } }).response
    expect(response.commands).toEqual([{ name: 'compact', description: 'x', builtin: true }, { name: 'command-1', description: '', builtin: false }])
    expect(response.account).toEqual({ email: '<email>', organization: '<organization>', subscriptionType: '<plan>', apiProvider: 'firstParty' })
    expect(JSON.stringify([init, answer])).not.toMatch(/alice|Notion|acme|secret/i)
  })

  it('reads a path under a placeholder folder with `/`, and scrubs a streamed path joined, though its pieces were cut in the middle of the name', () => {
    const delta = (text: string) => line('in', { type: 'stream_event', api_message_id: 'msg_01', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    const frames = run([
      delta('see C:\\Users\\al'),
      delta('ice\\Documents\\a.txt and '),
      line('in', { type: 'user', message: { content: [{ type: 'tool_result', content: `${CWD}\\sub\\note.txt` }] } }),
    ])
    const pieces = frames.slice(0, 2).map((f) => ((f.msg.event as { delta: { text: string } }).delta.text))
    expect(pieces.join('')).toBe('see <home>/Documents/a.txt and ')
    expect(JSON.stringify(frames[2]!.msg)).toContain('<cwd>/sub/note.txt')
  })

  it('scrubs a tool input streamed as JSON though other messages come between its pieces, and leaves its escapes alone', () => {
    const input = { command: `Get-Content "${HOME}\\Docs\\a.txt"`, content: 'one\ntwo' }
    const text = JSON.stringify(input)
    const at = text.indexOf('alice')
    const cuts = [text.slice(0, at + 2), text.slice(at + 2, at + 9), text.slice(at + 9)]
    const piece = (partial_json: string) => line('in', { type: 'stream_event', api_message_id: 'msg_01', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } } })
    const frames = run([
      piece(cuts[0]!),
      line('in', { type: 'control_response', response: { subtype: 'success', request_id: 'q1', response: {} } }),
      piece(cuts[1]!),
      line('in', { type: 'system', subtype: 'status', status: 'requesting' }),
      piece(cuts[2]!),
    ])
    const streamed = frames.filter((f) => f.msg.type === 'stream_event').map((f) => (f.msg.event as { delta: { partial_json: string } }).delta.partial_json)
    expect(JSON.parse(streamed.join(''))).toEqual({ command: 'Get-Content "<home>/Docs/a.txt"', content: 'one\ntwo' })
  })
})
