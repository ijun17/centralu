import { describe, expect, it } from 'vitest'
import { AdapterCapabilities, launchRefusal } from '@cc/protocol'
import { AGY_CAPABILITIES } from './capabilities.js'
import { launchArgs } from './launch.js'
import { parseLine, STDERR, userLine } from './stream.js'
import { cardName, mcpServer, pathsOf, titleOf, toolKind } from './tool-kinds.js'

/** The small pure parts of the wire; frames here are written by hand from the shapes in `recordings/` */

describe('tool kinds', () => {
  it('names the kinds the gate decides by', () => {
    expect(['view_file', 'grep_search', 'run_command', 'write_to_file', 'write_file', 'call_mcp_tool', 'invoke_subagent'].map(toolKind)).toEqual(['read', 'read', 'execute', 'edit', 'edit', 'mcp', 'subagent'])
  })

  it('a name it does not know is `other`, which the gate answers with a card, never an allow', () => {
    // agy 1.4.8's own twelve tools (asked of the model): none is `other` (#1672 deep review finding 6)
    expect(['read_file', 'write_file', 'edit_file', 'run_command', 'manage_task', 'send_message', 'schedule', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'search_web', 'ask_question'].map((n) => toolKind(n))).toEqual(['read', 'edit', 'edit', 'execute', 'subagent', 'subagent', 'subagent', 'subagent', 'subagent', 'subagent', 'web', 'subagent'])
    expect(toolKind('manage_task', { Action: 'send_input', TaskId: 't', Input: 'y' })).toBe('execute')
    expect(toolKind('manage_task', { Action: 'kill', TaskId: 't' })).toBe('subagent')
    expect(toolKind('some_new_tool')).toBe('other')
    expect(toolKind('browser_click_element')).toBe('other')
    expect(toolKind('')).toBe('other')
  })

  it('reads a path from every argument name agy uses, once each', () => {
    expect(pathsOf({ Path: '/a', TargetFile: '/b', AbsolutePath: '/c', FilePath: '/d', SearchPath: '/e' })).toEqual(['/a', '/b', '/c', '/d', '/e'])
    expect(pathsOf({ Path: '/a', FilePath: '/a' })).toEqual(['/a'])
    expect(pathsOf({ Path: '  ', CommandLine: 'ls /x' })).toEqual([])
    expect(pathsOf(undefined)).toEqual([])
    // Every argument named like a path, lists too, and a path under a name nobody listed; never the text of an edit
    expect(pathsOf({ DirectoryPath: '/d', SearchDirectory: '/s', NotebookPath: '/n', FilePaths: ['/f1', '/f2'], TargetFiles: ['/t'], OutputPath: '/o', ImagePaths: ['/i'], Cwd: '/c' })).toEqual(['/d', '/s', '/n', '/f1', '/f2', '/t', '/o', '/i', '/c'])
    expect(pathsOf({ Path: '/a', NewThing: '/b', Rel: 'not/abs', Multi: '/x\n/y' })).toEqual(['/a', '/b'])
    expect(pathsOf({ Path: '/a', Content: '/ comment', Target: '/old', Replacement: '/new', CommandLine: '/bin/ls', Query: '/api/' })).toEqual(['/a'])
  })

  it('names a card as the other adapters do, and a call by what it does', () => {
    expect(['run_command', 'replace_file_content', 'view_file', 'find_by_name', 'read_url_content', 'search_web', 'list_dir'].map(cardName)).toEqual(['Bash', 'Edit', 'Read', 'Grep', 'WebFetch', 'WebSearch', 'list_dir'])
    expect(titleOf('run_command', { CommandLine: 'echo hi' })).toBe('echo hi')
    expect(titleOf('call_mcp_tool', { ServerName: 'centralu_centralu', ToolName: 'recall' })).toBe('centralu_centralu · recall')
    expect(titleOf('invoke_subagent', { Role: 'Runner', TypeName: 'self' })).toBe('Runner')
    expect(titleOf('write_file', { Path: '/w/a.txt' })).toBe('/w/a.txt')
    expect(titleOf('mystery', {})).toBe('mystery')
  })

  it('reads the MCP server a call names', () => {
    expect(mcpServer({ ServerName: 'centralu_centralu', ToolName: 'x' })).toBe('centralu_centralu')
    expect(mcpServer({})).toBe('')
  })
})

describe('stream lines', () => {
  it('writes an input as the one event agy runs a turn for', () => {
    expect(JSON.parse(userLine('a "quoted"\nline'))).toEqual({ event: 'user', message: { content: 'a "quoted"\nline' } })
  })

  it('reads the three events it maps, and passes through what it does not name', () => {
    expect(parseLine('{"event":"init","conversation_id":"c1","init":{"model":"m","extra":1}}')).toMatchObject({ event: 'init', conversation_id: 'c1' })
    expect(parseLine('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","new_field":true}}')).toMatchObject({ event: 'step_update', step_update: { step_index: 2, new_field: true } })
    expect(parseLine('{"event":"result","result":{"status":"SUCCESS","usage":null}}')).toMatchObject({ event: 'result', result: { status: 'SUCCESS' } })
  })

  it('an event it does not know, a known one that changed shape, and a line that is not JSON each say so', () => {
    expect(parseLine('{"event":"permission_request"}')).toEqual({ event: 'unknown', name: 'permission_request' })
    expect(parseLine('{"event":"init"}')).toEqual({ event: 'unknown', name: 'init' })
    expect(parseLine('{"nothing":1}')).toEqual({ event: 'unknown', name: '(no event)' })
    expect(parseLine('Fetching available models...')).toEqual({ event: 'unparsed', line: 'Fetching available models...' })
  })

  it('reads the stderr lines agy printed in the recordings', () => {
    expect(STDERR.notFound.exec('warning: conversation "abc-1" not found')?.[1]).toBe('abc-1')
    expect(STDERR.interrupted.test('error: interrupted')).toBe(true)
    expect(STDERR.loggedOut.test("Error: authentication required. Run 'agy' to log in, then retry.")).toBe(true)
    expect(STDERR.notFound.test('warning: something else')).toBe(false)
  })
})

describe('launch arguments', () => {
  const base = ['--input-format', 'stream-json', '--output-format', 'stream-json']

  it('starts a new conversation under the gate alone, with the empty prompt last', () => {
    expect(launchArgs({ model: 'gemini-3.8-flash-low', pluginRoot: '/p' })).toEqual([...base, '--model', 'gemini-3.8-flash-low', '--dangerously-skip-permissions', '--add-dir', '/p', '-p='])
  })

  it('resumes by the conversation id, never by "the latest"', () => {
    const args = launchArgs({ model: 'm', effort: 'high', pluginRoot: '/p', resume: 'c1' })
    expect(args).toEqual([...base, '--model', 'm', '--effort', 'high', '--dangerously-skip-permissions', '--add-dir', '/p', '--conversation', 'c1', '-p='])
    expect(args).not.toContain('--continue')
  })

  it('leaves out a model or an effort it was not given', () => {
    expect(launchArgs({ pluginRoot: '/p' })).toEqual([...base, '--dangerously-skip-permissions', '--add-dir', '/p', '-p='])
  })
})

describe('capabilities', () => {
  it('are a valid declaration, with no context window and the host queueing input', () => {
    expect(AdapterCapabilities.safeParse(AGY_CAPABILITIES).success).toBe(true)
    expect(AGY_CAPABILITIES).toMatchObject({ contextUsage: 'none', midTurnInput: false, gatesSteps: true, approvals: true, resume: true })
    expect(AGY_CAPABILITIES).not.toHaveProperty('compactCommand')
  })

  it('cannot be kept from reading the repository, so an untrusted project is refused it', () => {
    expect(launchRefusal(AGY_CAPABILITIES, 'Antigravity', { permissionPreset: 'normal' })).toContain('trusted projects')
    expect(launchRefusal(AGY_CAPABILITIES, 'Antigravity', { permissionPreset: 'normal', projectTrusted: true })).toBeNull()
  })
})
