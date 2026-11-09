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

  it('keeps the name of the recorder’s own probe server and its tool, and renames a connector of the person’s', () => {
    const [init, call] = run([
      line('in', { type: 'system', subtype: 'init', cwd: CWD, tools: ['Bash', 'mcp__probe__ping', 'mcp__claude_ai_Notion__search'] }),
      line('in', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__probe__ping', input: {} }, { type: 'tool_use', id: 'toolu_02', name: 'mcp__claude_ai_Notion__search', input: {} }] } }),
    ]).map((f) => f.msg)
    expect((init as { tools: string[] }).tools).toEqual(['Bash', 'mcp__probe__ping'])
    const names = ((call as { message: { content: { name: string }[] } }).message.content).map((b) => b.name)
    expect(names[0]).toBe('mcp__probe__ping')
    expect(names[1]).not.toMatch(/Notion/)
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

  it('numbers the id OpenCode gives a tool output’s file the same wherever it is named, in a path and in the output’s own words', () => {
    const name = 'tool_1aff99a540016nieUyWEeXJ0u2'
    const frames = run([line('in', { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', rawOutput: { output: `Full output saved to: ${CWD}/${name}\n`, metadata: { outputPath: `${CWD}/${name}` } } } } })])
    expect(JSON.stringify(frames)).not.toContain('1aff99a5')
    expect(JSON.stringify(frames)).toContain('<cwd>/tool_000001')
  })

  it('numbers a session id cut across two streamed pieces as one id, the same as when it stands whole in another frame', () => {
    const id = '3142d2fb-5f69-431e-b37f-2a6507fbb140'
    const piece = (partial_json: string) => line('in', { type: 'stream_event', api_message_id: 'msg_01', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } } })
    const text = JSON.stringify({ file_path: `${CWD}\\tasks\\${id}\\a.output` })
    const at = text.indexOf(id) + 13
    const frames = run([piece(text.slice(0, at)), piece(text.slice(at)), line('in', { type: 'system', subtype: 'status', session_id: id })])
    const streamed = frames.slice(0, 2).map((f) => (f.msg.event as { delta: { partial_json: string } }).delta.partial_json).join('')
    const whole = String(frames[2]!.msg.session_id)
    expect(JSON.parse(streamed)).toEqual({ file_path: `<cwd>/tasks/${whole}/a.output` })
    expect(JSON.stringify(frames)).not.toContain('3142d2fb')
  })
})

describe('scrubbing Codex’s frames', () => {
  const MAC_CWD = '/private/var/folders/ab/cdef123456/T/run-1'
  const macRun = (frames: ReturnType<typeof line>[]) => scrub(frames, MAC_CWD, '/Users/alice', { tmp: '/var/folders/ab/cdef123456/T', user: 'alice' }) as { dir: string; msg: Record<string, unknown> }[]

  it('says nothing of the bridge’s credential, address, program or file in a thread’s config, nor of the folders its trust map lists', () => {
    const [started] = macRun([
      line('out', {
        id: 'r-1',
        method: 'thread/start',
        params: {
          cwd: MAC_CWD,
          config: {
            mcp_servers: { centralu: { command: '/opt/homebrew/Cellar/node/26.1.0/bin/node', args: ['/Users/alice/work/packages/agent-host/src/adapters/codex/centralu-bridge.mjs'], env: { CC_HOST_URL: 'ws://127.0.0.1:55501', CC_BRIDGE_TOKEN: 'ccb1:5f87ace6-4f22-4f28-a061-ce47a1ce47a1:FSTY7D4gMKh9Gu3w6VXv3rP-Jfox', CC_SESSION_ID: '988fabc8-f6d7-4ba3-950a-7db6e6ab3792' } } },
            projects: { [MAC_CWD]: { trust_level: 'untrusted' }, '/private/var/folders/ab/cdef123456': { trust_level: 'untrusted' }, '/private/var/folders/ab': { trust_level: 'untrusted' } },
          },
        },
      }),
    ]).map((f) => f.msg)
    const text = JSON.stringify(started)
    expect(text).not.toMatch(/FSTY7D4g|55501|alice|cdef123456|\/ab\b|homebrew/)
    expect(text).toContain('"CC_BRIDGE_TOKEN":"<secret>"')
    expect(text).toContain('"command":"<node>"')
    expect(text).toContain('"args":["<bridge>"]')
    const projects = (((started!.params as { config: { projects: object } }).config.projects) as Record<string, unknown>)
    expect(Object.keys(projects)).toContain('<cwd>')
  })

  it('keeps the skills that ship with Codex and numbers the person’s own, with nothing else of them', () => {
    const [answer] = macRun([
      line('in', {
        id: 'r-2',
        result: {
          data: [
            {
              cwd: MAC_CWD,
              skills: [
                { name: 'imagegen', description: 'Generate images', path: '/Users/alice/.codex/skills/.system/imagegen/SKILL.md', scope: 'system', enabled: true, pluginId: null },
                { name: 'my-private-skill', description: 'Does the thing alice does', path: '/Users/alice/.agents/skills/my-private-skill/SKILL.md', scope: 'user', enabled: true, pluginId: null },
              ],
            },
          ],
        },
      }),
    ]).map((f) => f.msg)
    const skills = ((answer!.result as { data: { skills: { name: string; description: string; path: string }[] }[] }).data[0]!).skills
    expect(skills[0]).toMatchObject({ name: 'imagegen', description: 'Generate images' })
    expect(skills[1]).toMatchObject({ name: 'skill-1', description: '', path: '<skill>' })
    expect(JSON.stringify(answer)).not.toMatch(/my-private-skill|alice/)
  })

  it('numbers the mailbox’s ids and drops the run’s folder suffix from a name made of it', () => {
    const [seen] = macRun([line('in', { id: 'r-3', result: { text: 'Sent hub-5b0933ff.m_01M6QZP77M7RJ0EEHDRB14Z371 to x; project frames-record-centralu-read-3e7fwc' } })]).map((f) => f.msg)
    expect(JSON.stringify(seen)).toBe(JSON.stringify({ id: 'r-3', result: { text: 'Sent hub-00000001.m_00000000000000000000000001 to x; project frames-record-centralu-read' } }))
  })

  it('drops the random suffix of a folder’s name that a streamed answer cuts into pieces (#2065)', () => {
    const delta = (itemId: string, piece: string) => line('in', { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId, delta: piece } })
    const pieces = ['Your project ', 'frames-record', '-other', '-B', 'GK', 'Z', 'To', ' is not trusted, nor frames-', 'data-', 'a1B2c3', '.']
    // Another item's text is another text: what ends one item's name and starts another's is not joined into a name
    const apart = [delta('m2', 'frames-record'), delta('m2', '-other'), delta('m3', '-B'), delta('m3', 'GKZTo')]
    const frames = macRun([...pieces.map((p) => delta('m1', p)), ...apart]).map((f) => (f.msg.params as { delta: string }).delta)
    expect(frames.slice(0, pieces.length).join('')).toBe('Your project frames-record-other is not trusted, nor frames-data.')
    expect(frames.slice(pieces.length)).toEqual(['frames-record', '-other', '-B', 'GKZTo'])
  })
})

describe('cutting a bulky text out of a recording', () => {
  it('keeps the start of a text over the limit and says how much was left out, in every place it appears, and leaves shorter text alone', () => {
    const big = 'x'.repeat(5000)
    const [out, delta, short] = scrub(
      [
        line('in', { method: 'item/completed', params: { item: { type: 'commandExecution', aggregatedOutput: big } } }),
        line('in', { method: 'item/commandExecution/outputDelta', params: { delta: big } }),
        line('in', { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'short' } } }),
      ],
      CWD,
      HOME,
      { tmp: 'C:\\Users\\alice\\AppData\\Local\\Temp', user: 'alice', cutText: 2000 },
    ).map((f) => (f as { msg: Record<string, unknown> }).msg)
    expect(JSON.stringify(out)).toContain(`${'x'.repeat(200)}…<cut 4800 characters>`)
    expect(JSON.stringify(delta)).toContain('<cut 4800 characters>')
    expect(JSON.stringify(short)).toContain('"text":"short"')
    expect(JSON.stringify([out, delta]).length).toBeLessThan(1000)
  })

  it('scrubs the text first, so the start that stays holds no path of the person’s', () => {
    const [kept] = scrub([line('in', { method: 'item/commandExecution/outputDelta', params: { delta: `${HOME}\\Docs\\a.txt and ${'z'.repeat(5000)}` } })], CWD, HOME, { tmp: 'C:\\Users\\alice\\AppData\\Local\\Temp', user: 'alice', cutText: 2000 }).map((f) => (f as { msg: Record<string, unknown> }).msg)
    expect(JSON.stringify(kept)).toContain('<home>/Docs/a.txt and zzz')
    expect(JSON.stringify(kept)).not.toContain('alice')
  })

  it('cuts nothing unless asked to', () => {
    const big = 'y'.repeat(5000)
    const [kept] = scrub([line('in', { id: 'r-1', result: { text: big } })], CWD, HOME, { tmp: 'C:\\Users\\alice\\AppData\\Local\\Temp', user: 'alice' }).map((f) => (f as { msg: Record<string, unknown> }).msg)
    expect(JSON.stringify(kept)).toContain(big)
  })
})
